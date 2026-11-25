/**
 * The Tuxler relay client.
 *
 * The app and the runner start it with `startTuxlerClient`, read `client.url` and
 * `GET /health`, and close it on shutdown. Everything below that is the protocol:
 * `control` runs one session, `frames` speaks the wire format, `change` reads what
 * the relay answers a change with, `validate` decides whether the address may be
 * used, `socks` serves one exit on a loopback port, and `exit` is the four together.
 */
export {
  startTuxlerClient,
  type TuxlerClient,
  type TuxlerClientOptions,
  type TuxlerHealth,
} from "./client";
export {
  buildHealth,
  bucketId,
  startHealthServer,
  type HealthBucket,
  type HealthExit,
  type HealthServer,
  type TuxlerHealthState,
} from "./health";
export {
  TuxlerSessionError,
  startSession,
  type SessionFailureReason,
  type SessionSnapshot,
  type TuxlerSession,
} from "./control";
export {
  encodeChangeRequest,
  isChangeReplyTag,
  parseChangeReply,
  type ChangeOutcome,
  type ChangeRequest,
  type ExitLocation,
} from "./change";
export {
  ExitRejectedError,
  openUsExit,
  type ExitFailureReason,
  type OpenExitOptions,
  type TuxlerExit,
} from "./exit";
export {
  isLoopbackPeer,
  startSocksServer,
  type SocksServer,
  type SocksServerOptions,
  type SocksTarget,
  type TunnelDialer,
} from "./socks";
export {
  HOSTING_ASNS,
  classifyAsn,
  cymruLookup,
  parseCymruOrigin,
  validateExit,
  type AsnLookup,
  type AsnRecord,
  type ExitRejectionReason,
  type ExitVerdict,
} from "./validate";
export { exitTunnelDialer, type ExitTunnelOptions } from "./transport";
export { type TuxlerAccountState, type TuxlerTier } from "./account";
