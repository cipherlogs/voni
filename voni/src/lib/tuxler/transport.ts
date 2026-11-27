/**
 * The socket layer between the client and the relay.
 *
 * The relay's exit tunnel masks every client→server byte with XOR-0x73 and leaves
 * server→client bytes raw; a nested hop is the same tunnel opened through an
 * existing exit with a `<h>host<p>port</p></h>` header in front. The endpoint
 * resolver exists so a test can map `serverN.ipsharkk.com` onto loopback without
 * the client learning that it is under test.
 *
 * The framing is fixed, not searched. Tuxler's own client writes exactly this on
 * every proxied connection, and a live probe on 2026-11-27 read `HTTP/1.1 200 OK`
 * back through it (see `docs/agents/tuxler-exit-protocol.md`). What matters when
 * dialling is subtler than framing: the relay never speaks before the payload
 * arrives, so the dialer must not wait for a byte, and a port this session no
 * longer owns is hung up at once. Both facts are encoded in `exitTunnelDialer`.
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

/**
 * A duplex over one relay socket. `maskOutbound` decides whether the bytes we
 * write carry the XOR-0x73 mask — inbound bytes are always raw. `onInbound`
 * observes every inbound chunk before it is offered to the reader; it never
 * consumes or reorders a byte, so a caller can record the relay's first words
 * without stealing them from the tunnel.
 */
class TunnelSocket extends Duplex {
  constructor(
    private readonly inner: Duplex,
    private readonly maskOutbound: boolean,
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

  /** Writes an already-framed prefix exactly as built, mask included. */
  writeFrame(bytes: Buffer): void {
    this.inner.write(bytes);
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.inner.write(this.maskOutbound ? xor73(chunk) : chunk, callback);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.inner.destroy();
    callback(error);
  }
}

/** Wraps a socket in the tunnel mask: writes are masked, reads pass through raw. */
export class XorSocket extends TunnelSocket {
  /**
   * `onInbound` observes every decrypted chunk as it arrives, before it is offered
   * to the reader; it never consumes or reorders a byte, so a caller can record
   * the relay's first words without stealing them from the tunnel.
   */
  constructor(inner: Duplex, onInbound?: (chunk: Buffer) => void) {
    super(inner, true, onInbound);
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
  /**
   * The hosts that may serve this exit port, in the order to try them: the host
   * the session was redirected to first, then the relay's configured entry host.
   * A real run had every port framing closed with no bytes on the redirected host,
   * so which host is dialled is a variable, not a constant.
   */
  relayHosts: readonly string[];
  /** The port the change reply named. Never the handshake's derived port. */
  exitPort: number;
  /** Where host names resolve. Identity in production; loopback in tests. */
  resolve?: EndpointResolver;
  connectTimeoutMs?: number;
  /** Dial the relay through something else — a parent exit — instead of directly. */
  dial?: (endpoint: RelayEndpoint) => Promise<Duplex>;
  /**
   * How long an uncached host may stay connected before the tunnel is taken as
   * open. The relay never speaks before the payload arrives, so this waits for the
   * opposite signal — an immediate hang-up. Defaults to 400 ms and is skipped on
   * the cached host, where a spent port is reported by the tunnel's own close.
   */
  openGraceMs?: number;
  /**
   * How the exit is named in log lines, e.g. `24.90.211.117:32516`. Defaults to
   * `<first relay host>:<exitPort>`, which is all the dialer knows on its own.
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
 * The one framing the exit port speaks. It is not a guess: Tuxler's own client
 * writes exactly this on every proxied connection (`SocksConnection.js`, shipped
 * build) — the destination header masked with XOR-0x73, then the payload masked the
 * same way, with server→client bytes raw. A live probe on 2026-11-27 sent this on
 * the port a change reply named and read `HTTP/1.1 200 OK` back from example.com.
 */
export function exitTunnelFrame(target: RelayEndpoint): Buffer {
  return xor73(Buffer.from(`<h>${target.host}<p>${target.port}</p></h>`, "latin1"));
}

/**
 * The host whose port accepted a connection, remembered for the process. The entry
 * host can refuse TCP outright while the redirected host serves the port, so the
 * host is a real variable — but proving it once is enough for every later dial.
 */
let acceptedHost: string | null = null;

/** Tests only: forget the host a previous dial learned. */
export function forgetAcceptedTunnelVariant(): void {
  acceptedHost = null;
}

/**
 * The relay's first words on a tunnel: how long they took, and — once — the line
 * that records them. Bytes are observed, never consumed.
 */
class Witness {
  private sentAt: number | null = null;
  private firstAt: number | null = null;

  constructor(private readonly note: (text: string) => void) {}

  /** The clock starts when the header is written, not when the socket opened. */
  markSent(): void {
    this.sentAt = Date.now();
  }

  observe(chunk: Buffer): void {
    if (this.firstAt !== null) return;
    this.firstAt = this.sentAt === null ? 0 : Date.now() - this.sentAt;
    const shown = Math.min(chunk.length, MAX_LOGGED_BYTES);
    this.note(`relay said ${shown}B: ${escapeBytes(chunk)}`);
  }
}

/** How long an uncached host may stay connected before the tunnel is taken as open. */
const DEFAULT_OPEN_GRACE_MS = 400;

/**
 * Wait out a tunnel's first moments, and report whether the relay kept it.
 *
 * The relay answers only once the payload arrives, and the payload only flows after
 * the SOCKS request is granted — so waiting for a byte here deadlocks every click.
 * That deadlock is what refused four probe runs: the port was open and correct the
 * whole time. What the relay *does* show immediately is the opposite: a port this
 * session does not own is hung up at once, so an early close is the one rejection
 * worth waiting for.
 */
function stillOpen(tunnel: Duplex, graceMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (tunnel.destroyed) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tunnel.off("close", onClose);
      tunnel.off("end", onClose);
      tunnel.off("error", onClose);
      resolve(open);
    };
    const onClose = (): void => finish(false);
    const timer = setTimeout(() => finish(true), Math.max(0, graceMs));
    (timer as unknown as { unref?: () => void }).unref?.();
    tunnel.once("close", onClose);
    tunnel.once("end", onClose);
    tunnel.once("error", onClose);
  });
}

/**
 * One proxied connection: dial the exit's relay port and hand back a tunnel that
 * names the real destination.
 *
 * One socket per browser connection, exactly as the shipped client does it. The
 * destination header is written before the tunnel is returned, because the relay
 * cannot answer a request it has not been told the target of.
 *
 * Safety, in the shape the protocol actually has: the only thing refused is a
 * connection that failed or was hung up. Bytes are never forwarded to an
 * unverified socket, because there is no way to verify one before the click's own
 * payload — the relay's silence is the protocol, not doubt.
 */
export function exitTunnelDialer(
  options: ExitTunnelOptions,
): (target: RelayEndpoint) => Promise<Duplex> {
  const resolve = options.resolve ?? identityResolver;
  const timeoutMs = options.connectTimeoutMs ?? 9_000;
  const connect =
    options.dial ?? ((endpoint: RelayEndpoint) => dial(endpoint, timeoutMs));
  const log = options.log ?? (() => {});
  const hosts = [
    ...new Set(options.relayHosts.map((host) => host.trim()).filter((host) => host !== "")),
  ];
  const label = oneLine(options.label ?? `${hosts[0] ?? "relay"}:${options.exitPort}`);
  const graceMs = options.openGraceMs ?? DEFAULT_OPEN_GRACE_MS;

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
    if (hosts.length === 0) {
      throw new Error(`no relay host was configured for exit port ${options.exitPort}`);
    }

    let lastConnectError: unknown = null;
    const ordered =
      acceptedHost !== null && hosts.includes(acceptedHost)
        ? [acceptedHost, ...hosts.filter((host) => host !== acceptedHost)]
        : hosts;

    for (const host of ordered) {
      const isCached = host === acceptedHost;
      let raw: Duplex;
      try {
        note(`tunnel connecting for ${destination} host=${host}`);
        raw = await connect(resolve(host, options.exitPort));
      } catch (error) {
        lastConnectError = error;
        const reason = oneLine(error instanceof Error ? error.message : String(error));
        note(`tunnel connect failed for ${destination} host=${host}: ${reason}`);
        continue;
      }

      const witness = new Witness(note);
      const tunnel = new TunnelSocket(raw, true, (chunk) => witness.observe(chunk));

      // The cached host was proved in this process and pays no grace: a port that
      // went stale surfaces as the tunnel closing under the click, which the SOCKS
      // layer already reports. An unproved host has to survive the hang-up window.
      if (!isCached && !(await stillOpen(tunnel, graceMs))) {
        tunnel.destroy();
        note(`host=${host} hung up before the header; this session does not own that port`);
        continue;
      }

      acceptedHost = host;
      note(`tunnel open for ${destination} host=${host}`);
      witness.markSent();
      tunnel.writeFrame(exitTunnelFrame(target));
      return tunnel;
    }

    // A host that could not even be dialled is reported as itself: its own error
    // is the honest reason, not a summary of hosts it never reached.
    if (lastConnectError !== null) throw lastConnectError;
    throw new Error(
      `every relay host hung up exit port ${options.exitPort}: ${hosts.join(", ")}`,
    );
  };
}
