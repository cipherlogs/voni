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
  constructor(private readonly inner: Duplex) {
    super();
    inner.on("data", (chunk: Buffer) => this.push(chunk));
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
  return async (target: RelayEndpoint) => {
    const raw = await connect(resolve(options.relayHost, options.exitPort));
    const tunnel = new XorSocket(raw);
    tunnel.write(Buffer.from(`<h>${target.host}<p>${target.port}</p></h>`, "latin1"));
    return tunnel;
  };
}
