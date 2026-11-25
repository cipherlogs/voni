/**
 * The Tuxler relay client.
 *
 * The app and the runner start it with `startTuxlerClient`, read `client.url` and
 * `GET /health`, and close it on shutdown. Everything below that is the protocol:
 * `control` runs one session, `frames` speaks the wire format, `change` reads what
 * the relay answers a change with, `validate` decides whether the address may be
 * used, `socks` serves one exit on a loopback port, `exit` is the four together,
 * and `pool` keeps five of those exits ready and hands them out one Click at a time.
 */
export {
  startTuxlerClient,
  type TuxlerClient,
  type TuxlerClientOptions,
  type TuxlerHealth,
  type TuxlerPoolOptions,
} from "./client";
export {
  buildHealth,
  bucketId,
  bucketReport,
  startHealthServer,
  type HealthBucket,
  type HealthExit,
  type HealthPool,
  type HealthServer,
  type TuxlerHealthState,
} from "./health";
export {
  POOL_ACQUIRE_WAIT_MS,
  POOL_DEPTH,
  POOL_MAX,
  POOL_PACE_BURST,
  POOL_PACE_COOLDOWN_MS,
  POOL_REFILL_BELOW,
  POOL_SILENCE_MS,
  POOL_TARGET,
  PoolUnavailableError,
  createExitPool,
  startExitPool,
  type BucketLink,
  type ExitLease,
  type ExitPool,
  type ExitPoolOptions,
  type PoolExitReport,
  type PoolSession,
  type PoolSnapshot,
  type PoolUnavailableReason,
} from "./pool";
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
export { exitTunnelDialer, tunneledTransport, type ExitTunnelOptions } from "./transport";
export { type TuxlerAccountState, type TuxlerTier } from "./account";
