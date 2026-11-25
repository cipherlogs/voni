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
import { xor73 } from "./transport";

/** One scripted answer to `CHANGE_IP_COUNTRY_CITY`, in the order the client asks. */
export type FakeChange =
  | {
      kind: "changed";
      ip?: string;
      countryIso?: string;
      country?: string;
      region?: string | null;
      city?: string | null;
      /** Answer with `…_BUT_LIMIT`: an exit now, and nothing left in this bucket. */
      lastOfBucket?: boolean;
    }
  | { kind: "no-change" }
  | { kind: "limit" }
  | { kind: "not-available" }
  | { kind: "overloaded" }
  | { kind: "not-entitled" }
  | { kind: "exit-unavailable"; limitReached?: boolean }
  /** A success tag with no port: the client must not invent one. */
  | { kind: "incomplete" }
  | { kind: "silent" };

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
  /** Change replies in order; the last one repeats. Absent means one US consumer exit. */
  changes?: FakeChange[];
  /** The exit address the default change reply names. */
  changeIp?: string;
  /** What the exit tunnels can reach. Anything else is refused, as the relay would. */
  tunnelHosts?: Record<string, "address-echo" | "echo" | "forward">;
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
  /** The port the handshake handed out; tests prove it is never served. */
  secondPort: number;
  /** One per change the client asked for. */
  changeRequests: number;
  /** Ports the relay named in change replies, in order. */
  exitPorts: number[];
  /** Connections onto exit tunnels, and the exit port each one landed on. */
  tunnelConnections: number;
  tunnelPorts: number[];
  tunnelTargets: Array<{ host: string; port: number }>;
  addressEchoRequests: number;
  /** Tunnels carried to a real destination — a parent exit reaching the relay. */
  forwardedConnections: number;
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
  changes: [],
  changeIp: "198.51.100.7",
  tunnelHosts: { "echo.example.test": "address-echo", "chatty.example.test": "echo" },
};

type Stage = "conformance" | "echo" | "second" | "connected";

/** The relay's control port; the only address the client is allowed to resolve. */
const CONTROL_PORT = 29990;

export class FakeRelay {
  private readonly options: Normalized;
  private readonly sockets = new Set<net.Socket>();
  private readonly servers: net.Server[] = [];
  /** Control sockets past login: a reset is pushed to them, as the relay does. */
  private readonly loggedIn = new Set<net.Socket>();
  /** The exit address behind each forwarded tunnel, keyed by the upstream local port. */
  private readonly forwardedFrom = new Map<number, string>();
  private controlPort = 0;
  private redirectPort = 0;
  private secondPort = 0;
  private conformancePort = 0;
  /** Changes are answered one at a time, in the order they were asked. */
  private changeQueue: Promise<void> = Promise.resolve();
  private changesAnswered = 0;
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
    secondPort: 0,
    changeRequests: 0,
    exitPorts: [],
    tunnelConnections: 0,
    tunnelPorts: [],
    tunnelTargets: [],
    addressEchoRequests: 0,
    forwardedConnections: 0,
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
      exitPorts: [...this.counters.exitPorts],
      tunnelPorts: [...this.counters.tunnelPorts],
      tunnelTargets: this.counters.tunnelTargets.map((target) => ({ ...target })),
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
    this.loggedIn.clear();
    this.forwardedFrom.clear();
    await Promise.all(
      this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }

  /**
   * Push a daily reset the way the relay does: `RESET_INFO` plus an
   * `ACCOUNT_INFO` whose usage has fallen, which is what a client can observe.
   */
  pushReset(resetAt: string, changesUsed = 0): void {
    this.options.resetAt = resetAt;
    for (const socket of this.loggedIn) {
      if (socket.destroyed) continue;
      socket.write(encodeServerFrame("RESET_INFO", resetAt));
      socket.write(
        encodeServerFrame(
          "ACCOUNT_INFO",
          JSON.stringify({ currentIPLocationChanges: changesUsed, currentBandwidth: 1024 }),
        ),
      );
    }
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
    this.counters.secondPort = second;

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
    socket.on("close", () => this.loggedIn.delete(socket));
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
      if (tag === "CHANGE_IP_COUNTRY_CITY") {
        this.queueChange(socket);
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

  private queueChange(socket: net.Socket): void {
    this.counters.changeRequests += 1;
    this.changeQueue = this.changeQueue.then(() => this.sendChange(socket));
  }

  /**
   * Answer one `CHANGE_IP_COUNTRY_CITY`. A `changed` reply gets a real exit port
   * with a tunnel listener behind it, so a request through that port can only
   * succeed if the client used the port the reply named.
   */
  private async sendChange(socket: net.Socket): Promise<void> {
    const index = this.changesAnswered;
    this.changesAnswered += 1;
    const script = this.options.changes;
    const entry: FakeChange =
      script.length === 0 ? { kind: "changed" } : script[Math.min(index, script.length - 1)];
    if (socket.destroyed) return;

    const write = (tag: string, details = ""): void => {
      if (!socket.destroyed) socket.write(encodeServerFrame(tag, details));
    };

    if (entry.kind === "silent") return;

    const ip = entry.kind === "changed" ? (entry.ip ?? this.options.changeIp) : this.options.changeIp;
    const countryIso = entry.kind === "changed" ? (entry.countryIso ?? "US") : "US";
    const country = entry.kind === "changed" ? (entry.country ?? "United States") : "United States";
    const region = entry.kind === "changed" ? (entry.region ?? "Texas") : "Texas";
    const city = entry.kind === "changed" ? (entry.city ?? "Dallas") : "Dallas";
    const location =
      `<location><ip>${ip}</ip><country>${country}</country><countryiso>${countryIso}</countryiso>` +
      `<region>${region}</region><city>${city}</city></location>`;

    switch (entry.kind) {
      case "changed": {
        const port = await this.listenExit(ip);
        this.counters.exitPorts.push(port);
        write(
          entry.lastOfBucket ? "IP_CHANGED_SUCCESSFULLY_BUT_LIMIT" : "IP_CHANGED_SUCCESSFULLY",
          `<status>OK</status><ip>${ip}</ip>${location}<port>${port}</port>`,
        );
        return;
      }
      case "incomplete":
        write("IP_CHANGED_SUCCESSFULLY", `<status>OK</status><ip>${ip}</ip>${location}`);
        return;
      case "no-change":
        write(
          "IP_CHANGED_SUCCESSFULLY_ALREADY_USING",
          `<status>OK</status><ip>${ip}</ip>${location}`,
        );
        return;
      case "limit":
        write("IP_NOT_CHANGED_LIMITS", "<status>NOK</status>");
        return;
      case "not-available":
        write("IP_NOT_CHANGED_NOT_AVAILABLE");
        return;
      case "overloaded":
        write("IP_NOT_CHANGED_OVERLOADED");
        return;
      case "not-entitled":
        write("IP_CHANGED_FAILED_FREE");
        return;
      case "exit-unavailable":
        write(
          entry.limitReached
            ? "IP_BECAME_UNAVAILABLE_AND_YOU_HAVE_REACHED_LIMITS"
            : "IP_BECAME_UNAVAILABLE",
        );
        return;
      default:
        return;
    }
  }

  /** An exit port whose listener is the exit: unmask the header, find the target. */
  private async listenExit(exitIp: string): Promise<number> {
    const port = await this.listenOn((socket) => this.handleTunnel(port, exitIp, socket));
    return port;
  }

  private handleTunnel(exitPort: number, exitIp: string, socket: net.Socket): void {
    this.track(socket);
    this.counters.tunnelConnections += 1;
    this.counters.tunnelPorts.push(exitPort);

    let buffered = Buffer.alloc(0);
    let mode: "address-echo" | "echo" | "forward" | null = null;
    let upstream: net.Socket | null = null;

    socket.on("close", () => upstream?.destroy());

    socket.on("data", (chunk: Buffer) => {
      if (mode !== null) {
        // Client → relay is masked; the target, and so the answer, is clear.
        if (mode === "echo") socket.write(xor73(chunk));
        else if (mode === "forward") upstream?.write(xor73(chunk));
        return;
      }
      buffered = Buffer.concat([buffered, xor73(chunk)]);
      const end = buffered.indexOf("</h>");
      if (end === -1) return;
      const header = buffered.subarray(0, end + 4).toString("latin1");
      const rest = buffered.subarray(end + 4);
      const parsed = /^<h>([\s\S]*)<p>([\s\S]*)<\/p><\/h>$/.exec(header);
      if (parsed === null) {
        socket.destroy();
        return;
      }
      const targetHost = parsed[1];
      const targetPort = Number(parsed[2]);
      this.counters.tunnelTargets.push({ host: targetHost, port: targetPort });
      const reachable = this.options.tunnelHosts[targetHost];
      if (reachable === undefined) {
        // The relay could not reach the destination: the tunnel just closes.
        socket.destroy();
        return;
      }
      mode = reachable;
      if (mode === "address-echo") {
        this.counters.addressEchoRequests += 1;
        const body = `ip=${exitIp}\n`;
        socket.write(`HTTP/1.0 200 OK\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
        return;
      }
      if (mode === "echo") {
        if (rest.length > 0) socket.write(rest);
        return;
      }
      // `forward`: the hop is a real TCP destination, which is what a parent exit
      // is when a child bucket dials the relay through it. The exit address is
      // recorded so the relay can report it as that session's own client IP.
      this.counters.forwardedConnections += 1;
      const endpoint = this.resolve(targetHost, targetPort);
      upstream = net.connect({ host: endpoint.host, port: endpoint.port });
      this.track(upstream);
      upstream.on("connect", () => {
        this.forwardedFrom.set(upstream?.localPort ?? -1, exitIp);
        // `rest` is already unmasked from the wire, which is what the next hop
        // expects: a forwarded hop carries the client's tunnel one layer in.
        if (rest.length > 0) upstream?.write(rest);
      });
      upstream.on("data", (answer: Buffer) => {
        if (!socket.destroyed) socket.write(answer);
      });
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
    });
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
    this.loggedIn.add(socket);
    // A session dialled through an exit is metered separately by the relay, and
    // sees that exit's address as its client: a fresh bucket, keyed by that address.
    const viaExit = this.forwardedFrom.get(socket.remotePort ?? -1);
    const clientIp = viaExit ?? this.options.clientIp;
    const changesUsed = viaExit === undefined ? this.options.changesUsed : 0;
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
        JSON.stringify({ currentIPLocationChanges: changesUsed, currentBandwidth: 1024 }),
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
        `<location><ip>${clientIp}</ip><country>United States</country>` +
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
