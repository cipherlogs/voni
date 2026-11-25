/**
 * One relay session: connect, follow `CONNECT_LIST`, pass conformance, echo the
 * 50 KB block, open the second socket, log in, then stay alive on the relay's own
 * heartbeat clock.
 *
 * The rule this file exists to keep: nothing here derives a usable port from the
 * handshake. A handshake port routes the client's own address and is not a proxy,
 * so the session hands out no port at all — a usable exit arrives only with an
 * `IP_CHANGED_SUCCESSFULLY*` reply, in a later slice. The second socket is opened
 * because the protocol demands it, then read and thrown away: peer traffic is not
 * served.
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import { ControlReader, encodeClientFrame, type Frame } from "./frames";
import {
  applyAccountFrame,
  emptyAccountState,
  type TuxlerAccountState,
} from "./account";
import { directTransport, type EndpointResolver, type Transport } from "./transport";

export type SessionFailureReason =
  | "credential-missing"
  | "connect-failed"
  | "redirect-failed"
  | "conformance-failed"
  | "echo-failed"
  | "second-connection-failed"
  | "login-rejected"
  | "relay-silent"
  | "socket-closed";

export class TuxlerSessionError extends Error {
  constructor(
    readonly reason: SessionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "TuxlerSessionError";
  }
}

export interface SessionSnapshot {
  state: "connected" | "failed" | "stopped";
  host: string;
  handshakeMs: number | null;
  /** Seconds between `I_AM_ALIVE` frames, as the relay's `TIMEVAL` asked for. */
  heartbeatSeconds: number | null;
  /** The address the relay sees us from, live — not a snapshot taken at login. */
  clientIp: string | null;
  silentForMs: number | null;
  /** Tags this session understood, in the order they first appeared. */
  frames: string[];
  account: TuxlerAccountState;
  failure: { reason: SessionFailureReason; message: string } | null;
}

export interface TuxlerSession {
  snapshot(): SessionSnapshot;
  stop(): void;
}

export interface SessionOptions {
  host: string;
  port: number;
  email: string;
  password: string;
  /** Where `serverN.ipsharkk.com` resolves. Identity in production; loopback in tests. */
  resolveEndpoint?: EndpointResolver;
  /** Silence after which the session is unhealthy. Defaults to the announced `TIMEVAL`. */
  silenceMs?: number;
  /** Override the beat interval `TIMEVAL` would produce. */
  heartbeatSeconds?: number;
  /** Timeout for each handshake stage; the pump waits longer. */
  stageTimeoutMs?: number;
  onFrame?: (frame: Frame) => void;
}

const ECHO_BYTES = 50_000;
const MAX_REDIRECTS = 5;
const ECHO_SCAN_BYTES = 2_000;
const FALLBACK_TIMEVAL_SECONDS = 60;
const MAX_RECORDED_FRAMES = 64;

interface ProbeTarget {
  host: string;
  port: number;
  match: string;
  request: string;
}

export function parseProbeTargets(details: string): ProbeTarget[] {
  const pattern =
    /<CONNECTION><host>([\s\S]*?)<\/host><port>([\s\S]*?)<\/port><match>([\s\S]*?)<\/match><sendmessage>([\s\S]*?)<\/sendmessage><\/CONNECTION>/g;
  return [...details.matchAll(pattern)].map((match) => ({
    host: match[1],
    port: Number(match[2]),
    match: match[3],
    request: match[4],
  }));
}

/**
 * The relay asks the client to fetch its own conformance URLs over raw TCP. A
 * failure here is a `BADEXT`, not a crash: the probes only prove the client can
 * reach the internet.
 */
function runProbe(target: ProbeTarget, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let response = "";
    let settled = false;
    const socket = net.connect({ host: target.host, port: target.port });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", () => socket.write(Buffer.from(target.request, "latin1")));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
    });
    socket.on("end", () => finish(response.includes(target.match)));
    socket.on("close", () => finish(response.includes(target.match)));
    socket.on("error", () => finish(false));
  });
}

function readSendRequest(block: string): number {
  const open = block.indexOf("<SEND>");
  if (open === -1) return ECHO_BYTES;
  const close = block.indexOf("</SEND>", open);
  if (close === -1 || close <= open) return ECHO_BYTES;
  const requested = Number.parseInt(block.slice(open + "<SEND>".length, close), 10);
  if (!Number.isFinite(requested) || requested <= 0) return ECHO_BYTES;
  return Math.min(requested, ECHO_BYTES);
}

function readElement(details: string, element: string): string | null {
  const match = new RegExp(`<${element}>([^<]*)</${element}>`).exec(details);
  return match ? match[1] : null;
}

interface OpenedControl {
  host: string;
  socket: Duplex;
  reader: ControlReader;
  /** `CONNECT_LIST` tags followed to reach `host`. */
  redirects: string[];
}

export async function startSession(options: SessionOptions): Promise<TuxlerSession> {
  const email = options.email?.trim() ?? "";
  const password = options.password ?? "";
  if (email === "" || password === "") {
    throw new TuxlerSessionError(
      "credential-missing",
      "no relay credential configured: set TUXLER_EMAIL/TUXLER_USERNAME and TUXLER_PASSWORD/TUXLER_PASSWD",
    );
  }

  const stageTimeoutMs = options.stageTimeoutMs ?? 35_000;
  let stage: SessionFailureReason = "redirect-failed";
  const started = Date.now();

  let opened: OpenedControl;
  let second: Duplex;
  const handshakeTags: string[] = [];
  try {
    opened = await openControl(options, stageTimeoutMs);
    const { socket, reader } = opened;

    stage = "conformance-failed";
    const challenge = await reader.nextFrame(stageTimeoutMs);
    handshakeTags.push(challenge.tag);
    if (!challenge.tag.includes("MAKE_TEST_")) {
      throw new Error(`expected a conformance challenge, got ${challenge.tag}`);
    }
    const targets = parseProbeTargets(challenge.details);
    if (targets.length === 0) throw new Error("the conformance frame carried no targets");
    const verdicts = await Promise.all(targets.map((target) => runProbe(target, 8_000)));
    let testEnd = "<message>TEST_END<details>";
    for (const [index, target] of targets.entries()) {
      testEnd +=
        `<CONNECTION><host>${target.host}</host><port>${target.port}</port>` +
        `<recvmessage>${verdicts[index] ? "OKEXT" : "BADEXT"}</recvmessage></CONNECTION>`;
    }
    testEnd += "</details></message>";
    socket.write(Buffer.from(testEnd, "latin1"));
    socket.write(Buffer.from("VERSION3", "latin1"));

    stage = "echo-failed";
    reader.enterRawMode(ECHO_BYTES);
    const echo = await reader.rawBytes(stageTimeoutMs);
    const size = readSendRequest(echo.toString("latin1", 0, ECHO_SCAN_BYTES));
    socket.write(Buffer.from("OK" + "^".repeat(Math.max(0, size - 2)), "latin1"));

    stage = "second-connection-failed";
    const assignment = await reader.nextFrame(stageTimeoutMs);
    handshakeTags.push(assignment.tag);
    if (!assignment.tag.includes("MAKE_SECOND_CONNECTION")) {
      throw new Error(`expected MAKE_SECOND_CONNECTION, got ${assignment.tag}`);
    }
    const secondPort = Number(assignment.details);
    if (!Number.isFinite(secondPort) || secondPort <= 0) {
      throw new Error(`the relay assigned no usable port: ${assignment.details}`);
    }
    second = await dialSecond(options, secondPort);

    stage = "login-rejected";
    socket.write(
      encodeClientFrame(
        "LOGIN",
        `LOGIN:${email};NAME:;PASSWORD:${password};;SYSINFO:;VERSION:6;`,
      ),
    );
    const finished = await reader.nextFrame(stageTimeoutMs);
    handshakeTags.push(finished.tag);
    if (!finished.tag.includes("LOGIN_FINISHED")) {
      throw new TuxlerSessionError(
        "login-rejected",
        loginRejectionMessage(finished.tag),
      );
    }
  } catch (error) {
    throw asSessionError(error, stage);
  }

  const handshakeMs = Date.now() - started;
  const state = {
    phase: "connected" as SessionSnapshot["state"],
    clientIp: null as string | null,
    frames: [...opened.redirects, ...handshakeTags],
    account: emptyAccountState(),
    failure: null as SessionSnapshot["failure"],
    lastFrameAt: Date.now(),
    timevalSeconds: FALLBACK_TIMEVAL_SECONDS,
  };

  const socket = opened.socket;
  const reader = opened.reader;
  const secondSocket = second;

  // Peer assignments arrive here (`<C>n</C>`). Serving them is out of scope by
  // design: read the bytes, discard them, dial nothing.
  secondSocket.on("data", () => {});

  const record = (frame: Frame): void => {
    state.lastFrameAt = Date.now();
    if (!state.frames.includes(frame.tag) && state.frames.length < MAX_RECORDED_FRAMES) {
      state.frames.push(frame.tag);
    }
    if (frame.tag === "YOUR_IP") {
      const ip = readElement(frame.details, "ip") ?? readElement(frame.details, "ipAddress");
      if (ip !== null) state.clientIp = ip;
    }
    state.account = applyAccountFrame(state.account, frame);
    if (frame.tag === "TIMEVAL") {
      const seconds = Number.parseInt(frame.details, 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        state.timevalSeconds = seconds;
        scheduleHeartbeat();
      }
    }
    options.onFrame?.(frame);
  };

  const silenceMs = options.silenceMs ?? state.timevalSeconds * 1_000;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const sendBeat = (): void => {
    if (state.phase !== "connected" || socket.destroyed) return;
    socket.write(encodeClientFrame("I_AM_ALIVE"));
  };

  function scheduleHeartbeat(): void {
    if (heartbeat !== null) clearInterval(heartbeat);
    const seconds = options.heartbeatSeconds ?? Math.max(1, state.timevalSeconds - 10);
    heartbeat = setInterval(sendBeat, seconds * 1_000);
    (heartbeat as unknown as { unref?: () => void }).unref?.();
  }

  const fail = (reason: SessionFailureReason, message: string): void => {
    if (state.phase !== "connected") return;
    state.phase = "failed";
    state.failure = { reason, message };
    cleanup();
  };

  const cleanup = (): void => {
    if (heartbeat !== null) clearInterval(heartbeat);
    if (watchdog !== null) clearInterval(watchdog);
    heartbeat = null;
    watchdog = null;
    reader.destroy();
    socket.destroy();
    secondSocket.destroy();
  };

  const stop = (): void => {
    if (state.phase === "connected") state.phase = "stopped";
    cleanup();
  };

  reader.onClose(() => fail("socket-closed", "the relay closed the control socket"));
  socket.on("error", (error: Error) => fail("socket-closed", `control socket error: ${error.message}`));

  scheduleHeartbeat();
  const checkSilence = (): void => {
    if (state.phase !== "connected") return;
    const limit = options.silenceMs ?? state.timevalSeconds * 1_000;
    if (Date.now() - state.lastFrameAt > limit) {
      fail("relay-silent", `the relay sent nothing for ${limit} ms`);
    }
  };
  watchdog = setInterval(checkSilence, Math.max(25, Math.min(1_000, Math.floor(silenceMs / 4))));
  (watchdog as unknown as { unref?: () => void }).unref?.();

  const pump = async (): Promise<void> => {
    while (state.phase === "connected") {
      try {
        record(await reader.nextFrame(120_000));
      } catch {
        return;
      }
    }
  };
  void pump();

  return {
    snapshot(): SessionSnapshot {
      return {
        state: state.phase,
        host: opened.host,
        handshakeMs,
        heartbeatSeconds:
          options.heartbeatSeconds ?? Math.max(1, state.timevalSeconds - 10),
        clientIp: state.clientIp,
        silentForMs:
          state.phase === "connected" ? Math.max(0, Date.now() - state.lastFrameAt) : null,
        frames: [...state.frames],
        account: { ...state.account },
        failure: state.failure,
      };
    },
    stop,
  };
}

function loginRejectionMessage(tag: string): string {
  return `the relay refused the login (${tag}); a wrong or missing password looks like this`;
}

function asSessionError(error: unknown, stage: SessionFailureReason): TuxlerSessionError {
  if (error instanceof TuxlerSessionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (stage === "login-rejected") return new TuxlerSessionError(stage, loginRejectionMessage(message));
  return new TuxlerSessionError(stage, message);
}

async function dialSecond(options: SessionOptions, port: number): Promise<Duplex> {
  const transport = directTransport({
    host: options.host,
    port: options.port,
    resolve: options.resolveEndpoint,
  });
  return transport.openSecond(port);
}

async function openControl(
  options: SessionOptions,
  stageTimeoutMs: number,
): Promise<OpenedControl> {
  let host = options.host;
  const redirects: string[] = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const transport: Transport = directTransport({
      host,
      port: options.port,
      resolve: options.resolveEndpoint,
    });
    const socket = await transport.openControl().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new TuxlerSessionError(hop === 0 ? "connect-failed" : "redirect-failed", message);
    });
    const reader = new ControlReader(socket, { frameTimeoutMs: stageTimeoutMs });
    try {
      const first = await reader.nextFrame(stageTimeoutMs);
      if (first.tag !== "CONNECT_LIST") {
        reader.unshift(first);
        return { host, socket, reader, redirects };
      }
      if (hop === MAX_REDIRECTS) throw new Error("too many CONNECT_LIST redirects");
      const numbers = first.details
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean);
      if (numbers.length === 0) throw new Error("the relay sent an empty CONNECT_LIST");
      redirects.push(first.tag);
      host = `server${numbers[0]}.ipsharkk.com`;
      reader.destroy();
      socket.destroy();
    } catch (error) {
      reader.destroy();
      socket.destroy();
      throw error;
    }
  }
  throw new Error("too many CONNECT_LIST redirects");
}
