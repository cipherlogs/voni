/**
 * A relay that speaks the Tuxler protocol on loopback.
 *
 * This is the one seam the spec allows: everything above the protocol — the
 * session, the health report, and later the pool, the quota ledger and SOCKS — is
 * exercised through it, so no behaviour needs its own fake. It is a test double,
 * never a fallback: the client has no idea whether it is talking to this or to
 * `serverN.ipsharkk.com`, and the only thing the tests change is DNS.
 *
 * The script follows the real sequence byte for byte: conformance challenge →
 * 50 KB echo → second connection → LOGIN → account frames, with silent and
 * rejecting variants for the failure paths.
 */
import net from "node:net";
import { once } from "node:events";
import { encodeServerFrame, parseFrame } from "./frames";
import type { RelayEndpoint } from "./transport";

export interface FakeRelayOptions {
  email?: string;
  password?: string;
  /** Server number the first connection is redirected to; `null` disables it. */
  redirectServer?: number | null;
  /** `TIMEVAL` the relay announces; the client beats every `timeval − 10` seconds. */
  timevalSeconds?: number;
  clientIp?: string;
  premium?: boolean;
  changesUsed?: number;
  /** `ipLocationChangesLimit`. Never assume ten here — the test sets it. */
  changesLimit?: number;
  resetAt?: string;
  /** Reply size the client must produce for the echo (`<SEND>n</SEND>`). */
  sendBytes?: number;
  /** How a wrong password is answered: the relay's own silence, or the tag then a close. */
  loginRejection?: "close" | "unauthorized";
  /** Peer-assignment counts pushed on the second socket — traffic we must not serve. */
  peerCount?: number;
  /** Write nothing after login, so the client's silence watchdog is the only signal. */
  silentAfterLogin?: boolean;
  /** Accept the control connection and never write a frame. */
  silentOnConnect?: boolean;
  /** Destroy the control socket this long after a successful login. */
  dropAfterLoginMs?: number | null;
  /** Text the conformance target answers with; the client echoes `OKEXT` when it matches. */
  conformanceMatch?: string;
}

export interface FakeRelayStats {
  connectedHosts: string[];
  redirectConnections: number;
  controlConnections: number;
  /** Connections to the second socket: one from the client, more means peer serving. */
  secondConnections: number;
  loginAttempts: number;
  rejectedLogins: number;
  heartbeats: number;
  echoReplies: number;
  conformanceVerdicts: string[];
  version3: boolean;
  lastHeartbeatAt: number | null;
}

interface Normalized extends Required<Omit<FakeRelayOptions, "dropAfterLoginMs">> {
  dropAfterLoginMs: number | null;
}

const DEFAULTS: Normalized = {
  email: "operator@example.test",
  password: "correct-horse-battery",
  redirectServer: null,
  timevalSeconds: 60,
  clientIp: "203.0.113.9",
  premium: false,
  changesUsed: 3,
  changesLimit: 10,
  resetAt: "2026-11-26T08:26:00-05:00",
  sendBytes: 50_000,
  loginRejection: "close",
  peerCount: 0,
  silentAfterLogin: false,
  silentOnConnect: false,
  dropAfterLoginMs: null,
  conformanceMatch: "FAKE-RELAY-PROBE-OK",
};

type Stage = "conformance" | "echo" | "second" | "connected";

/** The relay's control port; the only address the client is allowed to resolve. */
const CONTROL_PORT = 29990;

export class FakeRelay {
  private readonly options: Normalized;
  private readonly sockets = new Set<net.Socket>();
  private readonly servers: net.Server[] = [];
  private controlPort = 0;
  private redirectPort = 0;
  private secondPort = 0;
  private conformancePort = 0;
  private readonly counters: FakeRelayStats = {
    connectedHosts: [],
    redirectConnections: 0,
    controlConnections: 0,
    secondConnections: 0,
    loginAttempts: 0,
    rejectedLogins: 0,
    heartbeats: 0,
    echoReplies: 0,
    conformanceVerdicts: [],
    version3: false,
    lastHeartbeatAt: null,
  };

  private constructor(options: FakeRelayOptions) {
    this.options = { ...DEFAULTS, ...stripUndefined(options) };
  }

  static async start(options: FakeRelayOptions = {}): Promise<FakeRelay> {
    const relay = new FakeRelay(options);
    await relay.listen();
    return relay;
  }

  get port(): number {
    return this.controlPort;
  }

  stats(): FakeRelayStats {
    return {
      ...this.counters,
      connectedHosts: [...this.counters.connectedHosts],
      conformanceVerdicts: [...this.counters.conformanceVerdicts],
    };
  }

  /**
   * Stands in for DNS only: a control connection to `serverN.ipsharkk.com:29990`
   * lands on loopback. A port the relay itself assigned is already loopback, so it
   * is passed through untouched.
   */
  resolve = (host: string, port: number): RelayEndpoint => {
    if (port !== CONTROL_PORT) return { host: "127.0.0.1", port };
    const hosts = this.counters.connectedHosts;
    if (hosts[hosts.length - 1] !== host) hosts.push(host);
    const match = /^server(\d+)\./i.exec(host);
    const server = match ? Number(match[1]) : 1;
    if (this.options.redirectServer !== null && server === 1) {
      this.counters.redirectConnections += 1;
      return { host: "127.0.0.1", port: this.redirectPort };
    }
    return { host: "127.0.0.1", port: this.controlPort };
  };

  async waitFor(
    predicate: (stats: FakeRelayStats) => boolean,
    timeoutMs = 5_000,
  ): Promise<FakeRelayStats> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const stats = this.stats();
      if (predicate(stats)) return stats;
      if (Date.now() > deadline) {
        throw new Error(`fake relay condition not met: ${JSON.stringify(stats)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(
      this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }

  private async listen(): Promise<void> {
    const conformance = await this.listenOn((socket) => {
      this.track(socket);
      socket.on("data", () => {
        socket.end(this.options.conformanceMatch + "\r\n");
      });
    });
    this.conformancePort = conformance;

    const second = await this.listenOn((socket) => this.handleSecond(socket));
    this.secondPort = second;

    const control = await this.listenOn((socket) => this.handleControl(socket));
    this.controlPort = control;

    if (this.options.redirectServer !== null) {
      this.redirectPort = await this.listenOn((socket) => {
        this.track(socket);
        socket.write(encodeServerFrame("CONNECT_LIST", `${this.options.redirectServer};`));
        after(500, () => socket.destroy());
      });
    } else {
      this.redirectPort = control;
    }
  }

  private async listenOn(handler: (socket: net.Socket) => void): Promise<number> {
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      handler(socket);
    });
    this.servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fake relay has no port");
    return address.port;
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
  }

  private handleSecond(socket: net.Socket): void {
    this.track(socket);
    this.counters.secondConnections += 1;
    // The relay pushes peer assignments here. We record them and serve nothing, which
    // is exactly the client behaviour the spec requires: read and ignore.
    if (this.options.peerCount > 0) {
      after(20, () => {
        if (!socket.destroyed) socket.write(Buffer.from(`<C>${this.options.peerCount}</C>`, "latin1"));
      });
    }
  }

  private handleControl(socket: net.Socket): void {
    this.track(socket);
    this.counters.controlConnections += 1;
    if (this.options.silentOnConnect) return;

    const echoTarget = this.options.sendBytes;
    let stage: Stage = "conformance";
    let text = "";
    let echoSeen = 0;
    let testEnded = false;

    const advance = (): void => {
      if (stage !== "conformance" || !testEnded) return;
      if (!text.includes("VERSION3")) return;
      text = "";
      stage = "echo";
      const payload =
        "TUXLER-ECHO-" +
        "x".repeat(Math.max(0, 50_000 - "TUXLER-ECHO-".length - `<SEND>${echoTarget}</SEND>`.length)) +
        `<SEND>${echoTarget}</SEND>`;
      socket.write(Buffer.from(payload, "latin1"));
    };

    const onFrame = (tag: string, details: string): void => {
      if (tag === "TEST_END") {
        testEnded = true;
        this.counters.conformanceVerdicts =
          details.match(/(OKEXT|BADEXT)/g)?.slice() ?? [];
        advance();
        return;
      }
      if (tag === "LOGIN") {
        this.handleLogin(socket, details, () => {
          stage = "connected";
        });
        return;
      }
      if (tag === "I_AM_ALIVE") {
        this.counters.heartbeats += 1;
        this.counters.lastHeartbeatAt = Date.now();
      }
    };

    socket.on("data", (chunk: Buffer) => {
      if (stage === "echo") {
        echoSeen += chunk.length;
        if (echoSeen >= echoTarget) {
          this.counters.echoReplies += 1;
          stage = "second";
          socket.write(encodeServerFrame("MAKE_SECOND_CONNECTION", String(this.secondPort)));
        }
        return;
      }
      text += chunk.toString("latin1");
      if (text.includes("VERSION3")) this.counters.version3 = true;
      let end = text.indexOf("</message>");
      while (end !== -1) {
        const raw = text.slice(0, end + "</message>".length);
        text = text.slice(end + "</message>".length);
        const frame = parseFrame(raw);
        onFrame(frame.tag, frame.details);
        end = text.indexOf("</message>");
      }
      if (stage === "conformance") advance();
    });

    this.sendChallenge(socket);
  }

  private sendChallenge(socket: net.Socket): void {
    const target = `127.0.0.1`;
    const details =
      `<CONNECTION><host>${target}</host><port>${this.conformancePort}</port>` +
      `<match>${this.options.conformanceMatch}</match>` +
      `<sendmessage>PROBE / HTTP/1.0\r\n\r\n</sendmessage></CONNECTION>`;
    socket.write(encodeServerFrame("MAKE_TEST_1", details));
  }

  private handleLogin(socket: net.Socket, details: string, onAccepted: () => void): void {
    this.counters.loginAttempts += 1;
    const fields = new Map<string, string>();
    for (const part of details.split(";")) {
      const at = part.indexOf(":");
      if (at === -1) continue;
      fields.set(part.slice(0, at).trim(), part.slice(at + 1));
    }
    const accepted =
      fields.get("LOGIN") === this.options.email && fields.get("PASSWORD") === this.options.password;
    if (!accepted) {
      this.counters.rejectedLogins += 1;
      if (this.options.loginRejection === "unauthorized") {
        socket.write(encodeServerFrame("UNAUTHORIZED_ACCESS", ""));
      }
      after(20, () => socket.destroy());
      return;
    }
    onAccepted();
    socket.write(encodeServerFrame("LOGIN_FINISHED", ""));
    if (this.options.silentAfterLogin) return;
    socket.write(encodeServerFrame("TIMEVAL", String(this.options.timevalSeconds)));
    socket.write(
      encodeServerFrame(
        "RECEIVED_ACCOUNT_INFO",
        `passok:1;premium:${this.options.premium ? "1" : "0"};email:${this.options.email};password:${this.options.password};`,
      ),
    );
    socket.write(
      encodeServerFrame(
        "ACCOUNT_INFO",
        JSON.stringify({ currentIPLocationChanges: this.options.changesUsed, currentBandwidth: 1024 }),
      ),
    );
    socket.write(
      encodeServerFrame(
        "LIMITS_INFO",
        JSON.stringify({
          ipLocationPoolLimit: 50,
          ipLocationChangesLimit: this.options.changesLimit,
          bandwidthLimit: -1,
          isIPSharingActive: false,
        }),
      ),
    );
    socket.write(encodeServerFrame("RESET_INFO", this.options.resetAt));
    socket.write(
      encodeServerFrame(
        "YOUR_IP",
        `<location><ip>${this.options.clientIp}</ip><country>United States</country>` +
          `<countryiso>US</countryiso><city>Dallas</city></location>`,
      ),
    );
    if (this.options.dropAfterLoginMs !== null) {
      after(this.options.dropAfterLoginMs, () => socket.destroy());
    }
  }
}

/** A timer that never keeps a test process alive. */
function after(ms: number, action: () => void): void {
  const timer = setTimeout(action, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
}

function stripUndefined(options: FakeRelayOptions): Partial<Normalized> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<Normalized>;
}
