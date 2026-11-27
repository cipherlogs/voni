/**
 * The socket layer between the client and the relay.
 *
 * The relay's exit tunnel masks every client→server byte with XOR-0x73 and leaves
 * server→client bytes raw; a nested hop is the same tunnel opened through an
 * existing exit with a `<h>host<p>port</p></h>` header in front. The endpoint
 * resolver exists so a test can map `serverN.ipsharkk.com` onto loopback without
 * the client learning that it is under test.
 *
 * The exit tunnel's framing came from the plan and was only ever proved against
 * our own fake relay; a real relay closed it without a byte. So the dialer now
 * tries the plausible framings in order and keeps the first one the relay
 * answers. Safety outranks progress here: a framing that has not produced a
 * response never carries a click (see `exitTunnelDialer`).
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
   * How long a framing may stay open without a byte before it is unproven.
   * Defaults to the SOCKS refusal window, 150 ms.
   */
  probeWindowMs?: number;
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

/** How long a framing may stay open without a byte before it is unproven. */
const DEFAULT_PROBE_WINDOW_MS = 150;

/** The framings an exit relay might expect. Ordered most likely first. */
export type TunnelVariantName = "masked-header" | "plain-header" | "plain" | "connect";

interface TunnelVariant {
  name: TunnelVariantName;
  /** The destination frame exactly as it goes on the wire, before any payload. */
  frame: (target: RelayEndpoint) => Buffer;
  /** Whether the payload this side writes is XOR-0x73 masked. Inbound is always raw. */
  maskPayload: boolean;
}

const TUNNEL_VARIANTS: readonly TunnelVariant[] = [
  {
    name: "masked-header",
    frame: (target) => xor73(Buffer.from(`<h>${target.host}<p>${target.port}</p></h>`, "latin1")),
    maskPayload: true,
  },
  {
    name: "plain-header",
    frame: (target) => Buffer.from(`<h>${target.host}<p>${target.port}</p></h>`, "latin1"),
    maskPayload: true,
  },
  {
    name: "plain",
    frame: (target) => Buffer.from(`<h>${target.host}<p>${target.port}</p></h>`, "latin1"),
    maskPayload: false,
  },
  {
    name: "connect",
    frame: (target) =>
      Buffer.from(
        `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
          `Host: ${target.host}:${target.port}\r\n\r\n`,
        "latin1",
      ),
    maskPayload: true,
  },
];

function variantNamed(name: TunnelVariantName): TunnelVariant {
  const variant = TUNNEL_VARIANTS.find((candidate) => candidate.name === name);
  if (variant === undefined) throw new Error(`unknown tunnel variant ${name}`);
  return variant;
}

/**
 * The framing that produced a response, remembered for the process. A working
 * framing is never re-probed: each probe costs a live exit's time, and the first
 * dial after it wins is enough evidence for every later dial.
 */
let acceptedVariant: TunnelVariantName | null = null;

/** Tests only: forget what a previous dial learned, so the sweep is observable. */
export function forgetAcceptedTunnelVariant(): void {
  acceptedVariant = null;
}

/**
 * The relay's first words on one attempt: how long they took, and — once — the
 * line that records them. Bytes are observed, never consumed.
 */
class Witness {
  private sentAt: number | null = null;
  private firstAt: number | null = null;
  private listener: (() => void) | null = null;

  constructor(private readonly note: (text: string) => void) {}

  /** The clock starts when the frame is written, not when the socket opened. */
  markSent(): void {
    this.sentAt = Date.now();
  }

  /** Milliseconds from the frame to the first inbound byte, or `null`. */
  firstByteMs(): number | null {
    return this.firstAt;
  }

  /** Runs the moment the first byte arrives, or at once if it already has. */
  onFirstByte(listener: () => void): void {
    this.listener = listener;
    if (this.firstAt !== null) listener();
  }

  observe(chunk: Buffer): void {
    if (this.firstAt !== null) return;
    this.firstAt = this.sentAt === null ? 0 : Date.now() - this.sentAt;
    const shown = Math.min(chunk.length, MAX_LOGGED_BYTES);
    this.note(`relay said ${shown}B: ${escapeBytes(chunk)}`);
    this.listener?.();
  }
}

type ProbeOutcome =
  | { kind: "answered"; firstByteMs: number }
  | { kind: "rejected" }
  | { kind: "silent" };

/**
 * Decide one framing inside `windowMs`. Any inbound byte is the relay answering,
 * so the framing is accepted. A close with no bytes is a rejection. Staying open
 * with no bytes is neither: it is unproven, and an unproven framing is refused.
 */
function probeRelay(
  tunnel: Duplex,
  witness: Witness,
  send: () => void,
  windowMs: number,
): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const answered = (): ProbeOutcome => ({
      kind: "answered",
      firstByteMs: witness.firstByteMs() ?? 0,
    });
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      tunnel.off("end", onEnd);
      tunnel.off("close", onClose);
      tunnel.off("error", onError);
      resolve(outcome);
    };
    const onEnd = (): void => finish(witness.firstByteMs() === null ? { kind: "rejected" } : answered());
    const onClose = (): void =>
      finish(witness.firstByteMs() === null ? { kind: "rejected" } : answered());
    const onError = (): void =>
      finish(witness.firstByteMs() === null ? { kind: "rejected" } : answered());

    witness.onFirstByte(() => finish(answered()));
    tunnel.once("end", onEnd);
    tunnel.once("close", onClose);
    tunnel.once("error", onError);
    timer = setTimeout(
      () => finish(witness.firstByteMs() === null ? { kind: "silent" } : answered()),
      Math.max(0, windowMs),
    );
    (timer as unknown as { unref?: () => void }).unref?.();
    if (tunnel.destroyed) {
      finish({ kind: "rejected" });
      return;
    }
    witness.markSent();
    send();
  });
}

/**
 * One proxied connection: dial the exit's relay port, open a tunnel that names
 * the real destination, and only hand it back once the relay has answered.
 *
 * Safety: a variant may only carry traffic after it produced a response. A
 * socket that merely stayed open is never permission to forward a click's
 * bytes — a mis-framed request could be routed directly and expose the client's
 * address, the plan's single most dangerous failure mode. If only silence is
 * observed the dial is refused, exactly as a closed tunnel is.
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
  const windowMs = options.probeWindowMs ?? DEFAULT_PROBE_WINDOW_MS;

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
    const endpoint = resolve(options.relayHost, options.exitPort);

    const openRaw = async (): Promise<Duplex> => {
      note(`tunnel connecting for ${destination}`);
      try {
        return await connect(endpoint);
      } catch (error) {
        const reason = oneLine(error instanceof Error ? error.message : String(error));
        note(`tunnel connect failed for ${destination}: ${reason}`);
        throw error;
      }
    };

    // A framing the relay answered earlier in this process was verified once;
    // later dials go straight to it and pay no probe.
    if (acceptedVariant !== null) {
      const variant = variantNamed(acceptedVariant);
      const raw = await openRaw();
      note(`tunnel connected for ${destination}`);
      const witness = new Witness(note);
      const tunnel = new TunnelSocket(raw, variant.maskPayload, (chunk) => witness.observe(chunk));
      const closedEarly = (): void => {
        if (witness.firstByteMs() !== null) return;
        note(`relay closed the tunnel before the destination answered (${destination})`);
      };
      tunnel.once("close", closedEarly);
      // A tunnel that was already gone when it arrived never emits its own close.
      if (raw.destroyed) closedEarly();
      note(`variant=${variant.name} reused (accepted earlier in this process)`);
      witness.markSent();
      tunnel.writeFrame(variant.frame(target));
      return tunnel;
    }

    const tried: TunnelVariantName[] = [];
    for (const [index, variant] of TUNNEL_VARIANTS.entries()) {
      const next = TUNNEL_VARIANTS[index + 1];
      const nextText = next === undefined ? "" : `; trying ${next.name}`;
      const raw = await openRaw();
      note(`tunnel connected for ${destination}`);

      if (raw.destroyed) {
        tried.push(variant.name);
        note(`variant=${variant.name} closed with no bytes${nextText}`);
        continue;
      }

      const witness = new Witness(note);
      const tunnel = new TunnelSocket(raw, variant.maskPayload, (chunk) => witness.observe(chunk));
      const outcome = await probeRelay(
        tunnel,
        witness,
        () => tunnel.writeFrame(variant.frame(target)),
        windowMs,
      );

      if (outcome.kind === "answered") {
        acceptedVariant = variant.name;
        note(`variant=${variant.name} accepted (first byte in ${outcome.firstByteMs} ms)`);
        return tunnel;
      }

      tunnel.destroy();
      if (outcome.kind === "silent") {
        // Silence is not evidence. Cache nothing and carry nothing: an unverified
        // framing must never forward a click, which is how a client address leaks.
        note(
          `variant=${variant.name} stayed open for ${windowMs} ms with no bytes;` +
            ` an unverified framing cannot carry traffic, refusing ${destination}`,
        );
        throw new Error(
          `the relay did not answer the ${variant.name} framing for ${destination};` +
            " refusing because an unverified framing must never carry traffic",
        );
      }

      tried.push(variant.name);
      note(`variant=${variant.name} closed with no bytes${nextText}`);
    }

    const summary = tried.join(", ");
    note(`no variant answered for ${destination}; tried ${summary}`);
    throw new Error(`the relay closed every tunnel framing for ${destination}; tried ${summary}`);
  };
}
