/**
 * One exit, from a change reply to a working local port.
 *
 * The order is the rule: spend one change, read the relay's own reply, refuse it
 * unless it says US *and* the address is a consumer ISP, and only then bind a
 * loopback SOCKS listener on the port the reply named. There is no branch that
 * serves the handshake's derived port, and no branch that serves a connection
 * directly when the change fails: a rejection is an error with a reason, and the
 * caller gets no exit at all.
 *
 * Ticket 05 builds the pool on this function; a pool of these is five changes.
 */
import type { ChangeOutcome, ChangeRequest, ExitLocation } from "./change";
import { TuxlerSessionError, type TuxlerSession } from "./control";
import { startSocksServer, type SocksServer, type TunnelDialer } from "./socks";
import { exitTunnelDialer, type EndpointResolver } from "./transport";
import {
  cymruLookup,
  validateExit,
  type AsnLookup,
  type AsnRecord,
  type ExitRejectionReason,
} from "./validate";

/** Why an exit was not served. Each one is distinct on purpose: the pool counts them. */
export type ExitFailureReason =
  | ExitRejectionReason
  | "no-change"
  | "limit"
  | "not-available"
  | "overloaded"
  | "not-entitled"
  | "exit-unavailable"
  | "incomplete"
  | "unrecognised"
  | "relay-silent"
  | "session-closed"
  | "listener-failed";

export class ExitRejectedError extends Error {
  constructor(
    readonly reason: ExitFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "ExitRejectedError";
  }
}

export interface TuxlerExit {
  /** Stable within a session: the relay's own `ip:port` pair. */
  readonly id: string;
  readonly ip: string;
  /** The relay port from the change reply. Never derived from the handshake. */
  readonly port: number;
  readonly location: ExitLocation;
  readonly countryIso: string;
  readonly city: string | null;
  readonly asn: AsnRecord;
  /** The bucket had nothing left after this exit; usable now, nothing after it. */
  readonly lastOfBucket: boolean;
  readonly localPort: number;
  /** `socks5h://127.0.0.1:<port>` — what a browser context is given. */
  readonly socksUrl: string;
  readonly state: "ready" | "dead";
  /** Tunnels opened through this exit so far. */
  readonly requests: number;
  close: () => Promise<void>;
}

export interface OpenExitOptions {
  session: Pick<TuxlerSession, "requestChange">;
  /** The relay host the exit lives on, e.g. `server3.ipsharkk.com`. */
  relayHost: string;
  /** The ASN classifier. Defaults to the real Team Cymru lookup; tests inject one. */
  lookup?: AsnLookup;
  /** Where host names resolve. Identity in production; loopback in tests. */
  resolveEndpoint?: EndpointResolver;
  /** Local SOCKS port; `0` picks a free one. */
  socksPort?: number;
  changeTimeoutMs?: number;
  /** Override the tunnel to the relay — a parent-exit dial, for example. */
  dial?: TunnelDialer;
  refusalWindowMs?: number;
}

const REJECTION_TEXT: Record<ExitFailureReason, string> = {
  "not-us": "the change reply was not for the US",
  hosting: "the address is in a hosting ASN, not a consumer ISP",
  "lookup-failed": "the address's ASN could not be looked up",
  "no-change": "the relay reported it moved nothing",
  limit: "the bucket's change limit is spent",
  "not-available": "no US exit is available right now",
  overloaded: "the exit pool is overloaded",
  "not-entitled": "the account is not entitled to change location",
  "exit-unavailable": "the exit died before it could be used",
  incomplete: "the reply carried no usable port",
  unrecognised: "the relay's answer was not a change reply this client understands",
  "relay-silent": "the relay stopped answering",
  "session-closed": "the relay session is not connected",
  "listener-failed": "the local SOCKS listener could not be started",
};

function reject(reason: ExitFailureReason, detail?: string): never {
  const message = detail ? `${REJECTION_TEXT[reason]}: ${detail}` : REJECTION_TEXT[reason];
  throw new ExitRejectedError(reason, message);
}

export async function openUsExit(options: OpenExitOptions): Promise<TuxlerExit> {
  const request: ChangeRequest = { country: "US", city: "any", nearby: false };

  let outcome: ChangeOutcome;
  try {
    outcome = await options.session.requestChange(request, options.changeTimeoutMs);
  } catch (error) {
    if (error instanceof TuxlerSessionError) {
      reject(error.reason === "relay-silent" ? "relay-silent" : "session-closed", error.message);
    }
    throw error;
  }

  if (outcome.kind !== "changed") {
    reject(outcome.kind, outcome.tag);
  }

  const verdict = await validateExit({
    ip: outcome.ip,
    countryIso: outcome.location.countryIso,
    lookup: options.lookup ?? defaultLookup(),
  });
  if (!verdict.accepted) reject(verdict.reason, verdict.detail);

  const dial =
    options.dial ??
    exitTunnelDialer({
      relayHost: options.relayHost,
      exitPort: outcome.port,
      resolve: options.resolveEndpoint,
    });

  let server: SocksServer;
  try {
    server = await startSocksServer({
      port: options.socksPort,
      dial,
      refusalWindowMs: options.refusalWindowMs,
    });
  } catch (error) {
    reject("listener-failed", error instanceof Error ? error.message : String(error));
  }

  let state: TuxlerExit["state"] = "ready";
  const exit: TuxlerExit = {
    id: `${outcome.ip}:${outcome.port}`,
    ip: outcome.ip,
    port: outcome.port,
    location: outcome.location,
    countryIso: outcome.location.countryIso ?? "",
    city: outcome.location.city,
    asn: verdict.asn,
    lastOfBucket: outcome.lastOfBucket,
    localPort: server.port,
    socksUrl: server.url,
    get state() {
      return state;
    },
    get requests() {
      return server.requests();
    },
    close: async () => {
      if (state === "dead") return;
      state = "dead";
      await server.close();
    },
  };
  return exit;
}

/**
 * The real classifier is built once per process: its cache is what keeps a pool of
 * five exits from asking Team Cymru about the same /24 twice.
 */
let sharedLookup: AsnLookup | null = null;
function defaultLookup(): AsnLookup {
  sharedLookup ??= cymruLookup();
  return sharedLookup;
}
