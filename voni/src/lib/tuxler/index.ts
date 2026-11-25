/**
 * The Tuxler relay client.
 *
 * The app and the runner start it with `startTuxlerClient`, read `client.url` and
 * `GET /health`, and close it on shutdown. Everything below that is the protocol:
 * `control` runs one session, `frames` speaks the wire format, `account` reads what
 * the relay says about the account, `transport` moves the bytes.
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
export { type TuxlerAccountState, type TuxlerTier } from "./account";
