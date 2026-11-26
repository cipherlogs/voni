/**
 * The socket layer between the client and the relay.
 *
 * The relay's exit tunnel masks every client→server byte with XOR-0x73 and leaves
 * server→client bytes raw; a nested hop is the same tunnel opened through an
 * existing exit with a `<h>host<p>port</p></h>` header in front. The endpoint
 * resolver exists so a test can map `serverN.ipsharkk.com` onto loopback without
 * the client learning that it is under test.
 */
import net from "node:net";
import { Duplex } from "node:stream";
import { once } from "node:events";

export interface RelayEndpoint {
  host: string;
  port: number;
}

/** Produces the address a host resolves to. Real use is identity; tests map to loopback. */
export type EndpointResolver = (host: string, port: number) => RelayEndpoint;

export const identityResolver: EndpointResolver = (host, port) => ({ host, port });

/** The tunnel's outbound mask. Inbound bytes are never unmasked. */
export function xor73(bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) out[index] = bytes[index] ^ 0x73;
  return out;
}

/** Wraps a socket in the tunnel mask: writes are masked, reads pass through raw. */
export class XorSocket extends Duplex {
  /**
   * `onInbound` observes every decrypted chunk as it arrives, before it is offered
   * to the reader; it never consumes or reorders a byte, so a caller can record
   * the relay's first words without stealing them from the tunnel.
   */
  constructor(
    private readonly inner: Duplex,
    private readonly onInbound?: (chunk: Buffer) => void,
  ) {
    super();
    inner.on("data", (chunk: Buffer) => {
      this.onInbound?.(chunk);
      this.push(chunk);
    });
    inner.on("end", () => this.push(null));
    inner.on("close", () => this.destroy());
    inner.on("error", (error: Error) => this.destroy(error));
  }

  _read(): void {}

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.inner.write(xor73(chunk), callback);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.inner.destroy();
    callback(error);
  }
}

/** Where a control session dials from: the runner itself, or an earlier exit. */
export interface Transport {
  label: string;
  openControl: () => Promise<Duplex>;
  openSecond: (port: number) => Promise<Duplex>;
}

export interface DirectTransportOptions {
  host: string;
  port: number;
  resolve?: EndpointResolver;
  connectTimeoutMs?: number;
}

async function dial(endpoint: RelayEndpoint, timeoutMs: number): Promise<net.Socket> {
  const socket = net.connect({ host: endpoint.host, port: endpoint.port });
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15_000);
  try {
    await Promise.race([
      once(socket, "connect"),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`connect to ${endpoint.host}:${endpoint.port} timed out`)),
          timeoutMs,
        );
        (timer as unknown as { unref?: () => void }).unref?.();
        socket.once("connect", () => clearTimeout(timer));
        socket.once("error", () => clearTimeout(timer));
      }),
    ]);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return socket;
}

export function directTransport(options: DirectTransportOptions): Transport {
  const resolve = options.resolve ?? identityResolver;
  const timeoutMs = options.connectTimeoutMs ?? 9_000;
  return {
    label: `direct ${options.host}`,
    openControl: async () => dial(resolve(options.host, options.port), timeoutMs),
    openSecond: async (port: number) => dial(resolve(options.host, port), timeoutMs),
  };
}

/**
 * Dial the relay *through* an existing exit, so the relay sees that exit's address
 * as the client. Stacking two of these is a second hop; nothing else changes.
 */
export function tunnelTransport(
  parent: { host: string; port: number },
  relayHost: string,
  options: { connectTimeoutMs?: number } = {},
): Transport {
  const connect = async (port: number): Promise<Duplex> => {
    const raw = await dial({ host: parent.host, port: parent.port }, options.connectTimeoutMs ?? 9_000);
    const tunnel = new XorSocket(raw);
    tunnel.write(Buffer.from(`<h>${relayHost}<p>${port}</p></h>`, "latin1"));
    return tunnel;
  };
  return {
    label: `via exit :${parent.port}`,
    openControl: () => connect(29990),
    openSecond: (port: number) => connect(port),
  };
}

/**
 * A control session dialled through an earlier exit — how a child bucket is
 * opened. `dial` already carries the parent chain (one hop, or the nested chain
 * of a deeper bucket), so the transport only names the host and port to reach.
 */
export function tunneledTransport(
  dial: (target: RelayEndpoint) => Promise<Duplex>,
): (host: string) => Transport {
  return (host) => ({
    label: `via a parent exit to ${host}`,
    openControl: () => dial({ host, port: 29_990 }),
    openSecond: (port) => dial({ host, port }),
  });
}

export interface ExitTunnelOptions {
  /** The relay the exit lives on, e.g. `server3.ipsharkk.com`. */
  relayHost: string;
  /** The port the change reply named. Never the handshake's derived port. */
  exitPort: number;
  /** Where host names resolve. Identity in production; loopback in tests. */
  resolve?: EndpointResolver;
  connectTimeoutMs?: number;
  /** Dial the relay through something else — a parent exit — instead of directly. */
  dial?: (endpoint: RelayEndpoint) => Promise<Duplex>;
  /**
   * How the exit is named in log lines, e.g. `24.90.211.117:32516`. Defaults to
   * `<relayHost>:<exitPort>`, which is all the dialer knows on its own.
   */
  label?: string;
  /**
   * One line per tunnel event — connecting, connected, the relay's first words,
   * or an early close. Defaults to a no-op; the tunnel carries no credentials.
   */
  log?: (line: string) => void;
}

/** One line, bounded, and never a multi-line surprise from a relay message. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

const MAX_LOGGED_BYTES = 120;

/** Printable escape for a relay's first bytes: visible ASCII stays, the rest is `\xNN`. */
function escapeBytes(bytes: Buffer): string {
  const slice = bytes.subarray(0, MAX_LOGGED_BYTES);
  let out = "";
  for (const byte of slice) {
    if (byte === 0x5c) out += "\\\\";
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * One proxied connection: dial the exit's relay port, mask writes with XOR-0x73,
 * and put the real destination in front so the exit resolves it. This is the
 * consumer leg; the bytes coming back are already clear.
 */
export function exitTunnelDialer(
  options: ExitTunnelOptions,
): (target: RelayEndpoint) => Promise<Duplex> {
  const resolve = options.resolve ?? identityResolver;
  const timeoutMs = options.connectTimeoutMs ?? 9_000;
  const connect =
    options.dial ?? ((endpoint: RelayEndpoint) => dial(endpoint, timeoutMs));
  const log = options.log ?? (() => {});
  const label = oneLine(options.label ?? `${options.relayHost}:${options.exitPort}`);

  /** A witness, never a participant: a broken logger cannot stop a tunnel. */
  const note = (text: string): void => {
    try {
      log(`exit ${label} ${text}`);
    } catch {
      // swallowed on purpose
    }
  };

  return async (target: RelayEndpoint) => {
    const destination = `${target.host}:${target.port}`;
    note(`tunnel connecting for ${destination}`);
    let raw: Duplex;
    try {
      raw = await connect(resolve(options.relayHost, options.exitPort));
    } catch (error) {
      const reason = oneLine(error instanceof Error ? error.message : String(error));
      note(`tunnel connect failed for ${destination}: ${reason}`);
      throw error;
    }

    note(`tunnel connected for ${destination}`);

    let answered = false;
    const tunnel = new XorSocket(raw, (chunk) => {
      if (answered) return;
      answered = true;
      const shown = Math.min(chunk.length, MAX_LOGGED_BYTES);
      note(`relay said ${shown}B: ${escapeBytes(chunk)}`);
    });
    const closedEarly = (): void => {
      if (answered) return;
      note(`relay closed the tunnel before the destination answered (${destination})`);
    };
    tunnel.once("close", closedEarly);
    // A tunnel that was already gone when it arrived never emits its own close.
    if (raw.destroyed) closedEarly();

    tunnel.write(Buffer.from(`<h>${target.host}<p>${target.port}</p></h>`, "latin1"));
    return tunnel;
  };
}
