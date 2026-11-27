/**
 * Feasibility probe for a from-scratch Tuxler client.
 *
 * The shipped client is a Chrome Packaged App that no current browser can run.
 * This script speaks the same relay protocol over plain TCP to prove, before we
 * build the real client:
 *
 *   1. the relay accepts a non-Chrome handshake (conformance probes, 50 KB echo,
 *      second socket, LOGIN);
 *   2. the data plane works: a request through the assigned port reaches the
 *      internet and comes back;
 *   3. which rotation path actually moves the exit IP - a full reconnect or the
 *      quota-counted CHANGE_IP_COUNTRY_CITY command.
 *
 * Usage:
 *   node --import tsx scripts/tuxler-probe.mts --rotations 3
 *   node --import tsx scripts/tuxler-probe.mts --target https://api.ipify.org
 *
 * Credentials: TUXLER_EMAIL / TUXLER_PASSWORD, falling back to the public demo
 * login the free extension ships with.
 */
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { Duplex } from "node:stream";

import { isEntryPoint } from "./entry-point.mjs";

const CONTROL_HOST = process.env.TUXLER_HOST ?? "server1.ipsharkk.com";
const CONTROL_PORT = Number(process.env.TUXLER_CONTROL_PORT ?? 29990);
const EMAIL =
  process.env.TUXLER_EMAIL ?? process.env.TUXLER_USERNAME ?? "version3@login.com";
const PASSWORD =
  process.env.TUXLER_PASSWORD ?? process.env.TUXLER_PASSWD ?? "version3";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Frame {
  tag: string;
  details: string;
}

function parseFrame(raw: string): Frame {
  const open = raw.indexOf("<details>");
  if (open === -1) return { tag: raw, details: "" };
  const tag = raw.slice("<message>".length, open);
  const close = raw.lastIndexOf("</details>");
  return { tag, details: raw.slice(open + "<details>".length, close) };
}

/** The tunnel XORs every client->server byte; inbound bytes are plaintext. */
function xor73(bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ 0x73;
  return out;
}

class XorSocket extends Duplex {
  constructor(private readonly inner: Duplex) {
    super();
    inner.on("data", (chunk: Buffer) => this.push(chunk));
    inner.on("end", () => this.push(null));
    inner.on("close", () => this.destroy());
    inner.on("error", (error: Error) => this.destroy(error));
  }

  _read() {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.inner.write(xor73(chunk), callback);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
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

export function directTransport(host: string): Transport {
  return {
    label: `direct ${host}`,
    openControl: async () => {
      const socket = net.connect({ host, port: CONTROL_PORT });
      socket.setNoDelay(true);
      await once(socket, "connect");
      return socket;
    },
    openSecond: async (port: number) => {
      const socket = net.connect({ host, port });
      socket.setNoDelay(true);
      await once(socket, "connect");
      return socket;
    },
  };
}

/**
 * Dial the relay *through* an existing exit: the relay sees the exit's address
 * as the client, which is exactly what we want to test about quotas.
 */
export function tunnelTransport(
  parent: { host: string; port: number },
  relayHost: string,
): Transport {
  const dial = async (host: string, port: number): Promise<Duplex> => {
    const raw = net.connect({ host: parent.host, port: parent.port });
    raw.setNoDelay(true);
    await once(raw, "connect");
    const tunnel = new XorSocket(raw);
    tunnel.write(Buffer.from(`<h>${host}<p>${port}</p></h>`, "latin1"));
    return tunnel;
  };
  return {
    label: `via exit :${parent.port}`,
    openControl: () => dial(relayHost, CONTROL_PORT),
    openSecond: (port: number) => dial(relayHost, port),
  };
}

/**
 * Reads one control socket. The relay writes UTF-16LE text; this client writes
 * latin-1. During the throughput echo the stream is raw bytes.
 */
class Reader {
  private pending = Buffer.alloc(0);
  private text = "";
  private frames: Frame[] = [];
  private raw = false;
  private rawBuf: Buffer = Buffer.alloc(0);
  private rawTarget = 0;
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly socket: Duplex) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private async park(timeoutMs: number) {
    await Promise.race([
      new Promise<void>((resolve) => this.waiters.push(resolve)),
      sleep(Math.max(1, timeoutMs)),
    ]);
  }

  private onData(chunk: Buffer) {
    if (this.raw) {
      this.rawBuf = Buffer.concat([this.rawBuf, chunk]);
      if (this.rawBuf.length >= this.rawTarget) this.wake();
      return;
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    // A UTF-16 code unit can straddle two reads.
    const even = this.pending.subarray(0, this.pending.length - (this.pending.length % 2));
    this.text += even.toString("utf16le");
    this.pending = this.pending.subarray(even.length);
    let idx = this.text.indexOf("</message>");
    while (idx !== -1) {
      this.frames.push(parseFrame(this.text.slice(0, idx + "</message>".length)));
      this.text = this.text.slice(idx + "</message>".length);
      idx = this.text.indexOf("</message>");
    }
    this.wake();
  }

  unshift(frame: Frame) {
    this.frames.unshift(frame);
  }

  async nextFrame(timeoutMs = 20_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.frames.shift();
      if (frame) return frame;
      if (this.closed) throw new Error("control socket closed");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a frame");
      await this.park(left);
    }
  }

  enterRawMode(target: number) {
    this.raw = true;
    this.rawTarget = target;
    this.rawBuf = Buffer.alloc(0);
    this.text = "";
    this.frames = [];
  }

  async rawBytes(timeoutMs = 35_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.rawBuf.length < this.rawTarget) {
      if (this.closed) throw new Error("control socket closed during echo");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for the echo block");
      await this.park(left);
    }
    const out = this.rawBuf;
    this.raw = false;
    this.rawBuf = Buffer.alloc(0);
    return out;
  }
}

interface ProbeTarget {
  host: string;
  port: number;
  match: string;
  request: string;
}

function parseProbeTargets(details: string): ProbeTarget[] {
  const rx =
    /<CONNECTION><host>([\s\S]*?)<\/host><port>([\s\S]*?)<\/port><match>([\s\S]*?)<\/match><sendmessage>([\s\S]*?)<\/sendmessage><\/CONNECTION>/g;
  return [...details.matchAll(rx)].map((m) => ({
    host: m[1],
    port: Number(m[2]),
    match: m[3],
    request: m[4],
  }));
}

/** The relay makes the client fetch its own conformance URLs, raw TCP, no TLS. */
function runProbe(target: ProbeTarget): Promise<boolean> {
  return new Promise((resolve) => {
    let response = "";
    let settled = false;
    const socket = net.connect({ host: target.host, port: target.port });
    const timer = setTimeout(() => done(false), 8_000);
    function done(ok: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    }
    socket.setNoDelay(true);
    socket.on("connect", () => socket.write(Buffer.from(target.request, "latin1")));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
    });
    socket.on("end", () => done(response.includes(target.match)));
    socket.on("error", () => done(false));
    socket.on("close", () => done(response.includes(target.match)));
  });
}

export interface Session {
  host: string;
  port1: number;
  /** Port the server assigned for outbound traffic. */
  port2: number;
  exitIp: string | null;
  handshakeMs: number;
  socket: Duplex;
  second: Duplex;
  frames: Frame[];
  waitFor: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
  stop: () => void;
}

/**
 * One control session: connect, prove conformance, echo 50 KB, open the second
 * socket, log in, then keep draining the control channel.
 */
export async function startSession(
  options: {
    onFrame?: (frame: Frame) => void;
    openTransport?: (host: string) => Transport;
    email?: string;
    password?: string;
  } = {},
): Promise<Session> {
  let host = CONTROL_HOST;
  const started = Date.now();
  const openTransport = options.openTransport ?? ((target: string) => directTransport(target));
  let transport = openTransport(host);
  let socket: Duplex;
  let reader: Reader;

  // The relay can answer a connect with CONNECT_LIST - server numbers to try.
  for (let hop = 0; ; hop += 1) {
    if (hop > 5) throw new Error("too many CONNECT_LIST redirects");
    socket = await transport.openControl();
    reader = new Reader(socket);
    const first = await reader.nextFrame();
    if (first.tag !== "CONNECT_LIST") {
      reader.unshift(first);
      break;
    }
    const numbers = first.details
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
    if (numbers.length === 0) throw new Error("empty CONNECT_LIST");
    host = `server${numbers[0]}.ipsharkk.com`;
    transport = openTransport(host);
    socket.destroy();
  }

  const frames: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  const next = async (): Promise<Frame> => {
    const frame = await reader.nextFrame();
    frames.push(frame);
    for (const listener of listeners) listener(frame);
    options.onFrame?.(frame);
    return frame;
  };

  // 1. Conformance challenge.
  const challenge = await next();
  if (!challenge.tag.includes("MAKE_TEST_")) {
    throw new Error(`unexpected first frame: ${challenge.tag}`);
  }
  const targets = parseProbeTargets(challenge.details);
  if (targets.length === 0) throw new Error("conformance frame carried no targets");
  const verdicts = await Promise.all(targets.map(runProbe));

  let testEnd = "<message>TEST_END<details>";
  targets.forEach((target, index) => {
    testEnd +=
      "<CONNECTION><host>" +
      target.host +
      "</host><port>" +
      target.port +
      "</port><recvmessage>" +
      (verdicts[index] ? "OKEXT" : "BADEXT") +
      "</recvmessage></CONNECTION>";
  });
  testEnd += "</details></message>";
  socket.write(Buffer.from(testEnd, "latin1"));
  socket.write(Buffer.from("VERSION3", "latin1"));

  // 2. Throughput echo.
  reader.enterRawMode(50_000);
  const echo = await reader.rawBytes();
  const requested = /<SEND>(\d+)<\/SEND>/.exec(echo.toString("latin1"));
  const size = Math.min(Math.max(Number(requested?.[1] ?? 50_000), 1), 50_000);
  socket.write(Buffer.from("OK" + "^".repeat(Math.max(0, size - 2)), "latin1"));

  // 3. Port assignment on the second socket.
  const assignment = await next();
  if (!assignment.tag.includes("MAKE_SECOND_CONNECTION")) {
    throw new Error(`expected MAKE_SECOND_CONNECTION, got ${assignment.tag}`);
  }
  const port1 = Number(assignment.details);
  if (!Number.isFinite(port1) || port1 <= 0) {
    throw new Error(`bad port assignment: ${assignment.details}`);
  }
  const second = await transport.openSecond(port1);

  // 4. LOGIN.
  socket.write(
    Buffer.from(
      `<message>LOGIN<details>LOGIN:${EMAIL};NAME:;PASSWORD:${PASSWORD};;SYSINFO:;VERSION:6;</details></message>`,
      "latin1",
    ),
  );
  const finished = await next();
  if (!finished.tag.includes("LOGIN_FINISHED")) {
    throw new Error(`login rejected: ${finished.tag} ${finished.details.slice(0, 120)}`);
  }
  const handshakeMs = Date.now() - started;

  // 5. Background pump: TIMEVAL, heartbeats, account state, IP changes.
  let timeval = 60;
  let stopPump = false;
  const exit = { ip: null as string | null };
  const pump = (async () => {
    for (;;) {
      if (stopPump) return;
      try {
        const frame = await reader.nextFrame(120_000);
        frames.push(frame);
        if (frame.tag === "TIMEVAL") timeval = Number(frame.details) || 60;
        if (frame.tag === "YOUR_IP") exit.ip = /<ip>([^<]+)<\/ip>/.exec(frame.details)?.[1] ?? null;
        for (const listener of listeners) listener(frame);
        options.onFrame?.(frame);
      } catch {
        return;
      }
    }
  })();
  const beat = setInterval(() => {
    if (socket.destroyed) return;
    socket.write(Buffer.from("<message>I_AM_ALIVE<details></details></message>", "latin1"));
  }, Math.max(10, timeval - 10) * 1_000);

  const waitFor = (predicate: (frame: Frame) => boolean, timeoutMs = 20_000) =>
    new Promise<Frame>((resolve, reject) => {
      // Only frames that arrive after this call count: a historical reply is not
      // an answer to the request we are about to send.
      const baseline = frames.length;
      for (let index = baseline; index < frames.length; index += 1) {
        if (predicate(frames[index])) return resolve(frames[index]);
      }
      const listener = (frame: Frame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error("timed out waiting for a matching frame"));
      }, timeoutMs);
      listeners.add(listener);
    });

  const stop = () => {
    stopPump = true;
    clearInterval(beat);
    socket.destroy();
    second.destroy();
    void pump;
  };

  return {
    host,
    port1,
    port2: port1 + 1,
    exitIp: exit.ip,
    handshakeMs,
    socket,
    second,
    frames,
    waitFor,
    stop,
  };
}

export interface ChangeResult {
  ok: boolean;
  port: number | null;
  ip: string | null;
  tag: string;
  country: string | null;
  region: string | null;
  city: string | null;
}

/** Ask the relay to move the exit. The new outbound port arrives in the reply. */
export async function changeIp(
  session: Session,
  options: { country?: string; city?: string; nearby?: boolean; timeoutMs?: number } = {},
): Promise<ChangeResult> {
  const country = options.country?.trim() || "any";
  const city = encodeURIComponent(options.city?.trim() || "any");
  const nearby = options.nearby === false ? "0" : "1";
  const reply = session.waitFor(
    (frame) =>
      frame.tag.startsWith("IP_CHANGED") || frame.tag.startsWith("IP_NOT_CHANGED"),
    options.timeoutMs ?? 25_000,
  );
  session.socket.write(
    Buffer.from(
      `<message>CHANGE_IP_COUNTRY_CITY<details>next_nearby:${nearby};country:${country};city:${city};</details></message>`,
      "latin1",
    ),
  );
  const frame = await reply;
  const port = Number(/<port>(\d+)<\/port>/.exec(frame.details)?.[1] ?? 0);
  const ip = /<ip>([^<]+)<\/ip>/.exec(frame.details)?.[1] ?? null;
  const loc = (tag: string) =>
    new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(frame.details)?.[1] ?? null;
  const ok = frame.tag === "IP_CHANGED_SUCCESSFULLY" || frame.tag === "IP_CHANGED_SUCCESSFULLY_BUT_LIMIT";
  return {
    ok,
    port: Number.isFinite(port) && port > 0 ? port : null,
    ip,
    tag: frame.tag,
    country: loc("country"),
    region: loc("region"),
    city: loc("city"),
  };
}

/** Fetch a URL through one assigned exit port. */
export async function fetchThroughTunnel(
  session: Session,
  url: string,
  port: number,
  timeoutMs = 25_000,
): Promise<string> {
  const parsed = new URL(url);
  const targetPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const targetHost = parsed.hostname;
  const raw = net.connect({ host: session.host, port });
  raw.setNoDelay(true);
  await once(raw, "connect");
  const tunnel = new XorSocket(raw);
  tunnel.write(Buffer.from(`<h>${targetHost}<p>${targetPort}</p></h>`, "latin1"));

  const secure = parsed.protocol === "https:";
  const stream = secure
    ? tls.connect({ socket: tunnel as unknown as net.Socket, servername: targetHost, rejectUnauthorized: false })
    : tunnel;
  if (secure) await once(stream, "secureConnect");

  stream.write(
    `GET ${parsed.pathname || "/"}${parsed.search} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: tuxler-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
  );
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => stream.destroy(), timeoutMs);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  } finally {
    clearTimeout(timer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.slice(body.indexOf("\r\n\r\n") + 4).trim();
}

async function runReciprocity() {
  const session = await startSession({
    onFrame: (frame) => {
      if (frame.tag === "TIMEVAL" || frame.tag === "IPLIST") return;
      console.log(`  <= ${frame.tag} ${frame.details.slice(0, 80)}`);
    },
  });
  console.log(`session ${session.host} port1=${session.port1} port2=${session.port2}`);

  // Serve every inbound assignment the relay queues for us.
  const served: string[] = [];
  let secondBuf = "";
  session.second.on("data", (chunk: Buffer) => {
    secondBuf += chunk.toString("latin1");
    for (;;) {
      const close = secondBuf.indexOf("</C>");
      if (close === -1) break;
      const open = secondBuf.indexOf("<C>");
      if (open === -1 || open > close) break;
      const count = Number(secondBuf.slice(open + 3, close));
      secondBuf = secondBuf.slice(close + 4);
      for (let i = 0; i < count; i += 1) {
        const relay = net.connect({ host: session.host, port: session.port1 });
        let header = Buffer.alloc(0);
        let dest: net.Socket | undefined;
        relay.on("data", (data: Buffer) => {
          if (dest) {
            dest.write(data);
            return;
          }
          header = Buffer.concat([header, data]);
          const text = header.toString("latin1");
          const match = /<h>([\s\S]*?)<p>([\s\S]*?)<\/p><\/h>/.exec(text);
          if (!match) return;
          served.push(`${match[1]}:${match[2]}`);
          const rest = header.subarray(text.indexOf("</h>") + 4);
          dest = net.connect({ host: match[1], port: Number(match[2]) });
          dest.on("connect", () => {
            if (rest.length) dest!.write(rest);
            dest!.on("data", (fromDest: Buffer) => relay.write(fromDest));
          });
          dest.on("error", () => {});
        });
        relay.on("error", () => {});
        relay.on("close", () => dest?.destroy());
      }
    }
  });

  await sleep(4_000);
  console.log(`served ${served.length} inbound assignment(s): ${served.slice(0, 5).join(", ")}`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const ip = await fetchThroughTunnel(session, "https://api.ipify.org", session.port2, 20_000);
      console.log(`  outbound via port1+1 -> ${ip}`);
    } catch (error) {
      console.log(`  outbound via port1+1 -> FAILED ${(error as Error).message}`);
    }
    await sleep(1_000);
  }
  session.stop();
}

async function runPoolTest() {
  const session = await startSession({});
  const change = await changeIp(session);
  console.log(`change -> ${change.tag} port=${change.port} ip=${change.ip}`);
  if (!change.port) {
    console.log("no port assigned; aborting");
    session.stop();
    return;
  }
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const one = Date.now();
      try {
        const ip = await fetchThroughTunnel(session, "https://api.ipify.org", change.port!, 30_000);
        return `${index + 1}: ${ip} (${Date.now() - one} ms)`;
      } catch (error) {
        return `${index + 1}: FAILED ${(error as Error).message.slice(0, 60)} (${Date.now() - one} ms)`;
      }
    }),
  );
  console.log(`5 concurrent tunnels on one port, total ${Date.now() - started} ms`);
  for (const line of results) console.log(`  ${line}`);
  session.stop();
}

async function runIpQuota() {
  const a = await startSession({});
  const changeA = await changeIp(a);
  console.log(`session A: exit ${changeA.ip} port ${changeA.port}`);
  if (!changeA.port) throw new Error("session A got no port");

  const seen: string[] = [];
  const b = await startSession({
    openTransport: (host) =>
      tunnelTransport({ host: a.host, port: changeA.port! }, host),
    onFrame: (frame) => {
      if (frame.tag === "YOUR_IP")
        seen.push(`B relay sees client as ${/<ip>([^<]+)<\/ip>/.exec(frame.details)?.[1]}`);
      if (frame.tag === "ACCOUNT_INFO" || frame.tag === "LIMITS_INFO")
        seen.push(`B ${frame.tag} ${frame.details.slice(0, 120)}`);
    },
  });
  await sleep(4_000);

  const counter = (session: Session) => {
    const info = [...session.frames].reverse().find((frame) => frame.tag === "ACCOUNT_INFO");
    const limits = [...session.frames].reverse().find((frame) => frame.tag === "LIMITS_INFO");
    const used = info && /"currentIPLocationChanges":(\d+)/.exec(info.details)?.[1];
    const limit = limits && /"ipLocationChangesLimit":(-?\d+)/.exec(limits.details)?.[1];
    return `used=${used ?? "?"} limit=${limit ?? "?"}`;
  };
  console.log(`A (home IP):   ${counter(a)}`);
  console.log(`B (via exit):  ${counter(b)}`);
  for (const line of seen.slice(0, 4)) console.log(`  ${line}`);

  try {
    const changeB = await changeIp(b, { country: "DE", nearby: false, timeoutMs: 30_000 });
    console.log(`B change -> ${changeB.tag} ip=${changeB.ip} port=${changeB.port}`);
    console.log(`B after change: ${counter(b)}`);
    if (changeB.port) {
      const ip = await fetchThroughTunnel(b, "https://api.ipify.org", changeB.port, 30_000);
      console.log(`B tunnel via its new port -> ${ip}`);
    }
  } catch (error) {
    console.log(`B change failed: ${(error as Error).message}`);
  }
  a.stop();
  b.stop();
}

/** Fetch through a child exit that is itself reachable only through a parent exit. */
async function fetchNested(
  parent: { host: string; port: number },
  child: { host: string; port: number },
  url: string,
  timeoutMs = 30_000,
): Promise<string> {
  const parsed = new URL(url);
  const targetPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const raw = net.connect({ host: parent.host, port: parent.port });
  raw.setNoDelay(true);
  await once(raw, "connect");
  const outer = new XorSocket(raw);
  outer.write(Buffer.from(`<h>${child.host}<p>${child.port}</p></h>`, "latin1"));
  const inner = new XorSocket(outer);
  inner.write(Buffer.from(`<h>${parsed.hostname}<p>${targetPort}</p></h>`, "latin1"));
  const stream = parsed.protocol === "https:"
    ? tls.connect({ socket: inner as unknown as net.Socket, servername: parsed.hostname, rejectUnauthorized: false })
    : inner;
  if (parsed.protocol === "https:") await once(stream, "secureConnect");
  stream.write(
    `GET ${parsed.pathname || "/"} HTTP/1.1\r\nHost: ${parsed.hostname}\r\nUser-Agent: tuxler-probe\r\nConnection: close\r\n\r\n`,
  );
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => stream.destroy(), timeoutMs);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  } finally {
    clearTimeout(timer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.slice(body.indexOf("\r\n\r\n") + 4).trim();
}

async function runChainTest() {
  const a = await startSession({});
  const changeA = await changeIp(a, { country: "any", timeoutMs: 30_000 });
  console.log(`A exit ${changeA.ip} port ${changeA.port}`);
  if (!changeA.port) throw new Error("no A port");

  const b = await startSession({
    openTransport: (host) => tunnelTransport({ host: a.host, port: changeA.port! }, host),
  });
  const createdAt = Date.now();
  console.log(`B handshake through A: ${Date.now() - createdAt} ms (relay host ${b.host})`);

  const changeB = await changeIp(b, { country: "DE", nearby: false, timeoutMs: 30_000 });
  console.log(`B change -> ${changeB.tag} ip=${changeB.ip} port=${changeB.port}`);
  if (!changeB.port) throw new Error("no B port");

  const started = Date.now();
  try {
    const ip = await fetchNested(
      { host: a.host, port: changeA.port },
      { host: b.host, port: changeB.port },
      "https://api.ipify.org",
    );
    console.log(`nested fetch (A -> B) -> ${ip} in ${Date.now() - started} ms`);
    console.log(ip === changeB.ip ? "VERDICT: child exit works through the parent" : "VERDICT: unexpected exit IP");
  } catch (error) {
    console.log(`nested fetch FAILED after ${Date.now() - started} ms: ${(error as Error).message}`);
  }
  a.stop();
  b.stop();
}

async function runQuotaDepth() {
  const a = await startSession({});
  const changeA = await changeIp(a, { country: "any", timeoutMs: 30_000 });
  console.log(`A exit ${changeA.ip} port ${changeA.port} (home bucket)`);
  if (!changeA.port) throw new Error("no A port");

  const b = await startSession({
    openTransport: (host) => tunnelTransport({ host: a.host, port: changeA.port! }, host),
  });
  const counter = (session: Session) => {
    const info = [...session.frames].reverse().find((f) => f.tag === "ACCOUNT_INFO");
    return info && /"currentIPLocationChanges":(\d+)/.exec(info.details)?.[1];
  };
  console.log(`B bucket before: used=${counter(b)}`);

  let ok = 0;
  for (const country of ["DE", "FR", "NL", "ES"]) {
    const started = Date.now();
    try {
      const change = await changeIp(b, { country, nearby: false, timeoutMs: 35_000 });
      if (change.ok) ok += 1;
      console.log(
        `B -> ${country}: ${change.tag} ip=${change.ip} port=${change.port} in ${Date.now() - started} ms`,
      );
    } catch (error) {
      console.log(`B -> ${country}: FAILED ${(error as Error).message}`);
    }
    await sleep(1_500);
  }
  console.log(`child bucket: ${ok} successful changes after the home bucket was nearly spent`);
  console.log(`B bucket reported: used=${counter(b)}`);
  a.stop();
  b.stop();
}

async function runUsTest() {
  // The home bucket is nearly spent, so buy one root exit and test inside a child
  // bucket (its own 10). Country selection is enabled, city selection is not.
  const a = await startSession({});
  const changeA = await changeIp(a, { country: "any", timeoutMs: 30_000 });
  console.log(`root: ${changeA.tag} ip=${changeA.ip} ${changeA.country ?? "?"}/${changeA.city ?? "?"}`);
  if (!changeA.port) throw new Error("no root port");

  const b = await startSession({
    openTransport: (host) => tunnelTransport({ host: a.host, port: changeA.port! }, host),
  });
  const attempts = 10;
  let ok = 0;
  const ips = new Set<string>();
  const countries = new Map<string, number>();
  for (let index = 0; index < attempts; index += 1) {
    const started = Date.now();
    try {
      const change = await changeIp(b, { country: "US", nearby: false, timeoutMs: 35_000 });
      if (change.ok) ok += 1;
      if (change.ip) ips.add(change.ip);
      const country = change.country ?? "?";
      countries.set(country, (countries.get(country) ?? 0) + 1);
      console.log(
        `  ${index + 1}. ${change.tag} ip=${change.ip} ${country}/${change.city ?? "?"} in ${Date.now() - started} ms`,
      );
    } catch (error) {
      console.log(`  ${index + 1}. FAILED ${(error as Error).message}`);
    }
    await sleep(700);
  }
  console.log(`\nUS requested ${attempts}x: ${ok} successful, ${ips.size} unique IPs`);
  console.log(
    `countries returned: ${[...countries.entries()].map(([c, n]) => `${c}=${n}`).join(", ")}`,
  );
  a.stop();
  b.stop();
}

function parsePool(details: string) {
  const entries = [...details.matchAll(/<ipinfo>([\s\S]*?)<\/ipinfo>/g)].map((m) => {
    const field = (name: string) =>
      new RegExp(`<${name}>([^<]*)</${name}>`).exec(m[1])?.[1] ?? "";
    return {
      available: field("available").toUpperCase() === "YES",
      iso: field("countryiso"),
      country: field("country"),
      city: field("city"),
      id: field("id"),
      klass: field("class"),
    };
  });
  return entries;
}

async function runPoolScan() {
  const arg = (name: string, fallback: number) =>
    process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : fallback;
  const samples = arg("--samples", 3);
  const gapMs = arg("--gap", 20) * 1_000;
  let maxUs = 0;
  let totalUs = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const session = await startSession({});
    await sleep(6_000);
    const poolFrame = [...session.frames].reverse().find((f) => f.tag === "IPLIST");
    const account = [...session.frames].reverse().find((f) => f.tag === "ACCOUNT_INFO");
    const limits = [...session.frames].reverse().find((f) => f.tag === "LIMITS_INFO");
    if (!poolFrame) {
      console.log(`sample ${sample + 1}: no IPLIST received`);
      session.stop();
      continue;
    }
    const entries = parsePool(poolFrame.details);
    const unique = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) {
      const key = entry.id && entry.id !== "HIDDEN" ? entry.id : `${entry.iso}|${entry.city}`;
      if (!unique.has(key) || entry.available) unique.set(key, entry);
    }
    const available = [...unique.values()].filter((entry) => entry.available);
    const byCountry = new Map<string, number>();
    for (const entry of available) byCountry.set(entry.iso, (byCountry.get(entry.iso) ?? 0) + 1);
    const us = available.filter((entry) => entry.iso === "US");
    maxUs = Math.max(maxUs, us.length);
    totalUs += us.length;
    console.log(
      `\nsample ${sample + 1}: ${unique.size} unique entries, ${available.length} available, ${us.length} US`,
    );
    console.log(`  US cities: ${us.map((entry) => entry.city).sort().join(", ") || "none"}`);
    console.log(
      `  top: ${[...byCountry.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([iso, n]) => `${iso}=${n}`)
        .join(" ")}`,
    );
    if (account) console.log(`  pool size reported: ${account.details.slice(0, 90)}`);
    if (limits) console.log(`  limits: ${limits.details.slice(0, 150)}`);
    session.stop();
    if (sample < samples - 1) await sleep(gapMs);
  }
  console.log(
    `\nUS across ${samples} samples: max ${maxUs}, avg ${(totalUs / samples).toFixed(1)}`,
  );
}

async function runBanCheck() {
  const interesting = new Set([
    "BANNED_IP_HOSTING",
    "UNBANNED_IP_HOSTING",
    "IP_SHARING_STATE",
    "LIMITS_INFO",
    "RECEIVED_ACCOUNT_INFO",
  ]);
  let publicIp = "unknown";
  try {
    publicIp = (await fetch("https://api.ipify.org").then((r) => r.text())).trim();
  } catch {
    publicIp = "lookup failed";
  }
  console.log(`client public IP: ${publicIp}`);

  const session = await startSession({
    onFrame: (frame) => {
      if (interesting.has(frame.tag)) console.log(`<= ${frame.tag} ${frame.details.slice(0, 160)}`);
    },
  });
  console.log(`login ok, handshake ${session.handshakeMs} ms (no IP change spent)`);
  await sleep(15_000);

  const tags = [...new Set(session.frames.map((frame) => frame.tag))].sort();
  const banned = session.frames.some((frame) => frame.tag === "BANNED_IP_HOSTING");
  const unbanned = session.frames.some((frame) => frame.tag === "UNBANNED_IP_HOSTING");
  console.log(`frames seen: ${tags.join(" ")}`);
  console.log(
    banned
      ? "RESULT: BANNED_IP_HOSTING - this client address is rejected as hosted"
      : unbanned
        ? "RESULT: UNBANNED_IP_HOSTING - the relay explicitly unbanned this address"
        : "RESULT: no ban frame - this client address is accepted",
  );
  session.stop();
  process.exitCode = banned ? 3 : 0;
}

async function main() {
  if (process.argv.includes("--ban-check")) return runBanCheck();
  if (process.argv.includes("--pool-scan")) return runPoolScan();
  if (process.argv.includes("--us-test")) return runUsTest();
  if (process.argv.includes("--quota-depth")) return runQuotaDepth();
  if (process.argv.includes("--chain-test")) return runChainTest();
  if (process.argv.includes("--ip-quota")) return runIpQuota();
  if (process.argv.includes("--pool-test")) return runPoolTest();
  if (process.argv.includes("--reciprocity")) return runReciprocity();
  const rotations = Number(
    process.argv.includes("--rotations") ? process.argv[process.argv.indexOf("--rotations") + 1] : 2,
  );
  const target = process.argv.includes("--target")
    ? process.argv[process.argv.indexOf("--target") + 1]
    : "https://api.ipify.org";

  console.log(`relay   ${CONTROL_HOST}:${CONTROL_PORT}`);
  console.log(`account ${EMAIL.replace(/(.{2}).*(@.*)/, "$1***$2")}`);

  const reconnectIps: string[] = [];
  const changedIps: string[] = [];

  for (let attempt = 0; attempt < rotations; attempt += 1) {
    const session = await startSession({
      onFrame: (frame) => {
        if (frame.tag === "YOUR_IP" || frame.tag.startsWith("IP_CHANGED") || frame.tag.startsWith("IP_NOT_CHANGED")) {
          console.log(`  <= ${frame.tag} ${frame.details.slice(0, 100)}`);
        }
      },
    });
    await sleep(1_500);
    const reported = session.exitIp;
    if (reported) reconnectIps.push(reported);
    console.log(
      `session ${attempt + 1}: handshake ${session.handshakeMs} ms, port1 ${session.port1}, reported exit ${reported ?? "?"}`,
    );

    const change = await changeIp(session);
    console.log(`  change -> ${change.tag} port=${change.port} ip=${change.ip}`);
    const outboundPort = change.port ?? session.port2;

    try {
      const actual = await fetchThroughTunnel(session, target, outboundPort);
      if (change.ip) changedIps.push(change.ip);
      console.log(`  tunnel -> ${actual}`);
    } catch (error) {
      console.log(`  tunnel -> FAILED ${(error as Error).message}`);
    } finally {
      session.stop();
    }
    await sleep(500);
  }

  console.log(`\nreconnect exits: ${[...new Set(reconnectIps)].join(", ") || "none"}`);
  console.log(`changed exits:   ${[...new Set(changedIps)].join(", ") || "none"}`);
  console.log(
    `reconnect rotation: ${reconnectIps.length} session(s), ${new Set(reconnectIps).size} unique`,
  );
  console.log(
    new Set(reconnectIps).size > 1
      ? "VERDICT: a reconnect alone moves the exit"
      : "VERDICT: a reconnect reuses the exit",
  );
}

// The literal comparison of `import.meta.url` with a string-built `file://` URL
// is never true on Windows; see `entry-point.mjs`.
if (isEntryPoint(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error(`probe failed: ${error.message}`);
    process.exitCode = 1;
  });
}
