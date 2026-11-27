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
 * our own fake relay; a real relay closed it without a byte. So the dialer tries
 * the plausible framings on each plausible host in order — the session's redirect
 * host, then the relay's entry host — and keeps the first pair the relay answers.
 * A session's second socket is a candidate too, last, because it cannot
 * multiplex. Safety outranks progress here: a candidate that has not produced a
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
   * The session's authenticated second socket (the relay's data channel), or `null`
   * when it is busy or already closed. It is borrowed, never dialled: the accessor
   * enforces one tunnel at a time, so this variant is skipped rather than queued.
   * Absent means the dialer never considers it.
   */
  dataChannel?: () => Duplex | null;
  /**
   * How long a framing may stay open without a byte before it is unproven.
   * Defaults to the SOCKS refusal window, 150 ms.
   */
  probeWindowMs?: number;
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

/** How long a framing may stay open without a byte before it is unproven. */
const DEFAULT_PROBE_WINDOW_MS = 150;

/** The framings an exit relay might expect. Ordered most likely first. */
export type TunnelVariantName =
  | "masked-header"
  | "plain-header"
  | "plain"
  | "connect"
  | "data-channel";

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
 * The data channel carries the tunnel's best-guess framing — the XOR-0x73 masked
 * header, with the payload masked the same way — because it is only swept when no
 * port framing has been accepted yet. It is one variant, one write, one window: a
 * socket that answers and a socket that does not are the two outcomes that matter.
 */
const DATA_CHANNEL_VARIANT: TunnelVariant = {
  name: "data-channel",
  frame: (target) => xor73(Buffer.from(`<h>${target.host}<p>${target.port}</p></h>`, "latin1")),
  maskPayload: true,
};

/** A (host, framing) pair the relay answered, remembered for the process. */
interface AcceptedTunnel {
  host: string;
  variant: TunnelVariantName;
}

/**
 * The one candidate that produced a response, remembered for the process. A
 * working pair is never re-probed: each probe costs a live exit's time, and the
 * first dial after it wins is enough evidence for every later dial.
 */
let acceptedTunnel: AcceptedTunnel | null = null;

/** Tests only: forget what a previous dial learned, so the sweep is observable. */
export function forgetAcceptedTunnelVariant(): void {
  acceptedTunnel = null;
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
 * One proxied connection: dial an exit relay port, open a tunnel that names the
 * real destination, and only hand it back once the relay has answered.
 *
 * Two dimensions are swept, cheapest to rule out first: every framing on the
 * session's redirected host, then every framing on the relay's configured entry
 * host, then — only if the session lent it — the authenticated second socket. A
 * real run had every framing closed with no bytes on the redirected host, so the
 * host is a candidate too, and an unused second socket that survives a session
 * which closes fresh connections is the other.
 *
 * Safety: a candidate may only carry traffic after it produced a response. A
 * socket that merely stayed open is never permission to forward a click's bytes —
 * a mis-framed request could be routed directly and expose the client's address,
 * the plan's single most dangerous failure mode. If only silence is observed the
 * dial is refused, exactly as a closed tunnel is.
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
    if (hosts.length === 0) {
      throw new Error(`no relay host was configured for exit port ${options.exitPort}`);
    }

    let lastConnectError: unknown = null;

    /** Opens one port candidate; `null` is a connect failure, not a rejection. */
    const openRaw = async (host: string): Promise<Duplex | null> => {
      note(`tunnel connecting for ${destination} host=${host}`);
      try {
        return await connect(resolve(host, options.exitPort));
      } catch (error) {
        lastConnectError = error;
        const reason = oneLine(error instanceof Error ? error.message : String(error));
        note(`tunnel connect failed for ${destination} host=${host}: ${reason}`);
        return null;
      }
    };

    const watchEarlyClose = (tunnel: Duplex, witness: Witness): void => {
      const closedEarly = (): void => {
        if (witness.firstByteMs() !== null) return;
        note(`relay closed the tunnel before the destination answered (${destination})`);
      };
      tunnel.once("close", closedEarly);
      // A tunnel that was already gone when it arrived never emits its own close.
      if (tunnel.destroyed) closedEarly();
    };

    // A (host, framing) pair the relay answered earlier in this process was
    // verified once; later dials go straight to it and pay no probe.
    const accepted = acceptedTunnel;
    if (
      accepted !== null &&
      (accepted.variant === "data-channel" || hosts.includes(accepted.host))
    ) {
      if (accepted.variant === "data-channel") {
        const channel = options.dataChannel?.() ?? null;
        if (channel !== null) {
          note(`tunnel connected for ${destination} via the session's data channel`);
          const witness = new Witness(note);
          const tunnel = new TunnelSocket(channel, DATA_CHANNEL_VARIANT.maskPayload, (chunk) =>
            witness.observe(chunk),
          );
          watchEarlyClose(tunnel, witness);
          note("variant=data-channel reused (accepted earlier in this process)");
          witness.markSent();
          tunnel.writeFrame(DATA_CHANNEL_VARIANT.frame(target));
          return tunnel;
        }
        // The channel is one tunnel at a time and this session has spent it:
        // fall through to the port sweep rather than refusing the click, and
        // forget the pair so later dials do not ask a spent channel again.
        acceptedTunnel = null;
        note(
          "variant=data-channel reused but the channel is busy or closed;" +
            " sweeping the port variants",
        );
      } else {
        const variant = variantNamed(accepted.variant);
        const raw = await openRaw(accepted.host);
        if (raw !== null) {
          note(`tunnel connected for ${destination} host=${accepted.host}`);
          const witness = new Witness(note);
          const tunnel = new TunnelSocket(raw, variant.maskPayload, (chunk) =>
            witness.observe(chunk),
          );
          watchEarlyClose(tunnel, witness);
          note(`variant=${variant.name} reused (accepted earlier in this process)`);
          witness.markSent();
          tunnel.writeFrame(variant.frame(target));
          return tunnel;
        }
        // The cached host could not be re-dialled: sweep from the top instead of
        // failing a click the other host might serve.
        note(`variant=${variant.name} could not be re-dialled on ${accepted.host}; sweeping`);
        acceptedTunnel = null;
      }
    }

    const candidates: Array<
      { kind: "port"; host: string; variant: TunnelVariant } | { kind: "data-channel" }
    > = [];
    for (const host of hosts) {
      for (const variant of TUNNEL_VARIANTS) candidates.push({ kind: "port", host, variant });
    }
    if (options.dataChannel !== undefined) candidates.push({ kind: "data-channel" });

    const tried: string[] = [];
    const unreachableHosts = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      const nextText = index + 1 < candidates.length ? "; trying next" : "";

      if (candidate.kind === "data-channel") {
        // Last, because the channel is one socket and can never multiplex: a busy
        // channel is skipped, never queued behind another tunnel.
        const channel = options.dataChannel?.() ?? null;
        if (channel === null) {
          tried.push("data-channel");
          note(`variant=data-channel busy or absent; skipped${nextText}`);
          continue;
        }
        const witness = new Witness(note);
        const tunnel = new TunnelSocket(channel, DATA_CHANNEL_VARIANT.maskPayload, (chunk) =>
          witness.observe(chunk),
        );
        const outcome = await probeRelay(
          tunnel,
          witness,
          () => tunnel.writeFrame(DATA_CHANNEL_VARIANT.frame(target)),
          windowMs,
        );

        if (outcome.kind === "answered") {
          acceptedTunnel = { host: hosts[0] ?? "", variant: "data-channel" };
          note(
            `tunnel accepted on data-channel for ${destination}` +
              ` (first byte in ${outcome.firstByteMs} ms)`,
          );
          return tunnel;
        }

        // A rejection is the relay hanging up the whole channel, so there is no
        // socket left to continue the sweep on: end it here.
        tunnel.destroy();
        tried.push("data-channel");
        if (outcome.kind === "silent") {
          note(
            `variant=data-channel stayed open for ${windowMs} ms with no bytes;` +
              ` an unverified framing cannot carry traffic, refusing ${destination}`,
          );
          throw new Error(
            `the relay did not answer the data-channel framing for ${destination};` +
              " refusing because an unverified framing must never carry traffic",
          );
        }
        note(
          `variant=data-channel closed with no bytes; the relay hung up the session's` +
            ` channel, ending the sweep for ${destination}`,
        );
        throw new Error(
          `the relay closed the data-channel framing for ${destination};` +
            " the session's data channel is gone",
        );
      }

      const { host, variant } = candidate;
      if (unreachableHosts.has(host)) {
        // A host that refused the TCP connection refuses every framing equally:
        // one dial is the evidence, not four.
        tried.push(`${host}/${variant.name}`);
        continue;
      }
      const raw = await openRaw(host);
      if (raw === null) {
        unreachableHosts.add(host);
        tried.push(`${host}/${variant.name}`);
        continue;
      }
      note(`tunnel connected for ${destination} host=${host}`);

      if (raw.destroyed) {
        tried.push(`${host}/${variant.name}`);
        note(`host=${host} variant=${variant.name} closed with no bytes${nextText}`);
        continue;
      }

      const witness = new Witness(note);
      const tunnel = new TunnelSocket(raw, variant.maskPayload, (chunk) =>
        witness.observe(chunk),
      );
      const outcome = await probeRelay(
        tunnel,
        witness,
        () => tunnel.writeFrame(variant.frame(target)),
        windowMs,
      );

      if (outcome.kind === "answered") {
        acceptedTunnel = { host, variant: variant.name };
        note(
          `host=${host} variant=${variant.name} accepted (first byte in ${outcome.firstByteMs} ms)`,
        );
        return tunnel;
      }

      tunnel.destroy();
      if (outcome.kind === "silent") {
        // Silence is not evidence. Cache nothing and carry nothing: an unverified
        // framing must never forward a click, which is how a client address leaks.
        note(
          `host=${host} variant=${variant.name} stayed open for ${windowMs} ms with no bytes;` +
            ` an unverified framing cannot carry traffic, refusing ${destination}`,
        );
        throw new Error(
          `the relay did not answer the ${variant.name} framing for ${destination};` +
            " refusing because an unverified framing must never carry traffic",
        );
      }

      tried.push(`${host}/${variant.name}`);
      note(`host=${host} variant=${variant.name} closed with no bytes${nextText}`);
    }

    // A host that could not even be dialled is reported as itself: its own error
    // is the honest reason, not a summary of framings it never got to answer.
    if (lastConnectError !== null) throw lastConnectError;

    const summary = tried.join(", ");
    note(`no candidate answered for ${destination}; tried ${summary}`);
    throw new Error(`the relay closed every tunnel framing for ${destination}; tried ${summary}`);
  };
}
