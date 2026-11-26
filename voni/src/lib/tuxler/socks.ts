/**
 * One exit, served to this machine as a SOCKS5 port.
 *
 * The listener is the only thing a Click ever talks to: Chrome is given
 * `socks5h://127.0.0.1:<port>` and every CONNECT becomes a tunnel to *this exit's*
 * relay port with the requested host in the header, so the destination is resolved
 * by the exit, not by the host. It binds loopback only and closes any peer that is
 * not loopback, because an open port is an open proxy.
 *
 * The relay has no "upstream connected" answer on the consumer leg, so a granting
 * reply waits a short window: if the tunnel closes with nothing to say before it
 * ends, the destination refused and the client is told `0x05` instead of being
 * dropped. A destination that merely answers slowly is not penalised: the window
 * expires optimistically into a grant.
 */
import net from "node:net";
import { Duplex } from "node:stream";
import { once } from "node:events";

export interface SocksTarget {
  host: string;
  port: number;
}

/** Opens an exit tunnel for one destination: connect, send the header, stay open. */
export type TunnelDialer = (target: SocksTarget) => Promise<Duplex>;

export interface SocksServerOptions {
  /** Loopback only; any other host is refused. Defaults to `127.0.0.1`. */
  host?: string;
  /** `0` picks a free port. */
  port?: number;
  dial: TunnelDialer;
  /** How long to wait for the destination's first sign of life. Defaults to 150 ms. */
  refusalWindowMs?: number;
  /** How the exit behind this listener is named in log lines. Defaults to `null`. */
  exitLabel?: string | null;
  /**
   * One line per refused CONNECT, so a relay that closes every tunnel is visible.
   * Defaults to a no-op; the listener carries no credentials.
   */
  log?: (line: string) => void;
}

export interface SocksServer {
  host: string;
  /** `socks5h://127.0.0.1:<port>` — the only address a Click is given. */
  url: string;
  port: number;
  requests: () => number;
  refused: () => number;
  close: () => Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_REFUSAL_WINDOW_MS = 150;

const REPLY = {
  granted: [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0],
  hostUnreachable: [0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0],
  refused: [0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0],
  commandNotSupported: [0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0],
} as const;

const NO_ACCEPTABLE_METHODS = [0x05, 0xff] as const;

/** A peer address is loopback or it is not; IPv4-mapped IPv6 counts. */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (address === undefined) return false;
  const value = address.trim().toLowerCase();
  if (value === "::1") return true;
  if (value.startsWith("::ffff:")) return isLoopbackPeer(value.slice("::ffff:".length));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

function formatIPv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(bytes.readUInt16BE(index).toString(16));
  }
  return groups.join(":");
}

interface ParsedRequest {
  command: number;
  target: SocksTarget;
  /** Bytes the client sent after the request; they belong to the tunnel. */
  rest: Buffer;
}

/** Returns `null` while the request is still incomplete. */
function parseRequest(buffer: Buffer): ParsedRequest | null | "malformed" {
  if (buffer.length < 4) return null;
  const command = buffer[1];
  const addressType = buffer[3];
  let offset = 4;
  let host: string;
  if (addressType === 0x01) {
    if (buffer.length < offset + 4 + 2) return null;
    host = `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`;
    offset += 4;
  } else if (addressType === 0x04) {
    if (buffer.length < offset + 16 + 2) return null;
    host = formatIPv6(buffer.subarray(offset, offset + 16));
    offset += 16;
  } else if (addressType === 0x03) {
    if (buffer.length < offset + 1) return null;
    const length = buffer[offset];
    offset += 1;
    if (buffer.length < offset + length + 2) return null;
    host = buffer.subarray(offset, offset + length).toString("latin1").toLowerCase();
    offset += length;
  } else {
    return "malformed";
  }
  const port = buffer.readUInt16BE(offset);
  offset += 2;
  return { command, target: { host, port }, rest: buffer.subarray(offset) };
}

export async function startSocksServer(options: SocksServerOptions): Promise<SocksServer> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`the SOCKS listener binds loopback only; refusing to listen on ${host}`);
  }
  const windowMs = options.refusalWindowMs ?? DEFAULT_REFUSAL_WINDOW_MS;
  const exitLabel = options.exitLabel ?? null;
  const trace = options.log ?? (() => {});
  /** A witness, never a participant: a broken logger cannot stop a listener. */
  const note = (text: string): void => {
    try {
      trace(text.replace(/\s+/g, " ").trim().slice(0, 400));
    } catch {
      // swallowed on purpose
    }
  };
  let requests = 0;
  let refused = 0;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());

    if (!isLoopbackPeer(client.remoteAddress)) {
      // Not loopback: close without a reply. An open SOCKS port is an open proxy.
      client.destroy();
      return;
    }
    client.setNoDelay(true);
    client.setKeepAlive(true, 60_000);

    let buffer = Buffer.alloc(0);
    let stage: "greeting" | "request" | "open" = "greeting";

    const send = (bytes: readonly number[], end = false): void => {
      if (client.destroyed) return;
      client.write(Buffer.from(bytes));
      if (end) client.end();
    };

    const onData = (chunk: Buffer): void => {
      if (stage === "open") return;
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05) {
          client.destroy();
          return;
        }
        const methodCount = buffer[1];
        if (buffer.length < 2 + methodCount) return;
        const methods = buffer.subarray(2, 2 + methodCount);
        buffer = buffer.subarray(2 + methodCount);
        if (!methods.includes(0x00)) {
          send(NO_ACCEPTABLE_METHODS, true);
          return;
        }
        client.write(Buffer.from([0x05, 0x00]));
        stage = "request";
      }
      if (stage !== "request") return;

      const parsed = parseRequest(buffer);
      if (parsed === null) return;
      client.off("data", onData);
      if (parsed === "malformed") {
        refused += 1;
        send(REPLY.hostUnreachable, true);
        return;
      }
      if (parsed.command !== 0x01) {
        refused += 1;
        send(REPLY.commandNotSupported, true);
        return;
      }
      requests += 1;
      void openTunnel(parsed.target, parsed.rest);
    };

    const openTunnel = async (target: SocksTarget, rest: Buffer): Promise<void> => {
      let tunnel: Duplex;
      try {
        tunnel = await options.dial(target);
      } catch (error) {
        stage = "open";
        refused += 1;
        const detail = error instanceof Error ? error.message : String(error);
        note(
          `refused ${target.host}:${target.port}: the exit tunnel could not be opened` +
            ` exit=${exitLabel ?? "unknown"}: ${detail}`,
        );
        send(REPLY.refused, true);
        return;
      }
      const reachable = await confirmReachable(tunnel, windowMs);
      if (!reachable) {
        stage = "open";
        refused += 1;
        tunnel.destroy();
        note(
          `refused ${target.host}:${target.port}: the upstream refused before the destination` +
            ` answered exit=${exitLabel ?? "unknown"}`,
        );
        send(REPLY.refused, true);
        return;
      }
      stage = "open";
      send(REPLY.granted);
      tunnel.on("error", () => client.destroy());
      client.on("error", () => tunnel.destroy());
      client.on("close", () => tunnel.destroy());
      tunnel.on("close", () => client.destroy());
      tunnel.pipe(client);
      if (rest.length > 0) tunnel.write(rest);
      client.pipe(tunnel);
    };

    client.on("data", onData);
  });

  server.listen(options.port ?? 0, host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the SOCKS listener has no port");
  }

  return {
    host,
    port: address.port,
    url: `socks5h://${host}:${address.port}`,
    requests: () => requests,
    refused: () => refused,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

/**
 * The relay never says "upstream connected", so the only evidence a destination is
 * alive is its own first byte — or, failing that, that the tunnel is still open when
 * the window closes.
 */
function confirmReachable(tunnel: Duplex, windowMs: number): Promise<boolean> {
  if (tunnel.readableLength > 0) return Promise.resolve(true);
  // A tunnel that is already gone cannot be listened to for its own close.
  if (tunnel.destroyed) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    if (windowMs <= 0) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tunnel.off("readable", onReadable);
      tunnel.off("end", onEnd);
      tunnel.off("close", onClose);
      tunnel.off("error", onError);
      resolve(reachable);
    };
    const onReadable = (): void => {
      if (tunnel.readableLength > 0) finish(true);
    };
    const onEnd = (): void => finish(tunnel.readableLength > 0);
    const onClose = (): void => finish(tunnel.readableLength > 0);
    const onError = (): void => finish(false);
    tunnel.on("readable", onReadable);
    tunnel.once("end", onEnd);
    tunnel.once("close", onClose);
    tunnel.once("error", onError);
    const timer = setTimeout(() => finish(true), windowMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
