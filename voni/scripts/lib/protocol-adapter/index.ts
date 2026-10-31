/**
 * The protocol adapter: diagnosis over the public call boundary, never a
 * certificate.
 *
 * One scenario runs once through `POST /v1/call-body` and
 * `WS /v1/browser-call`; the call's own trace, end document, priced row and
 * received PCM are assembled into a run directory; the verdict engine judges
 * them and the card builder cites them.
 *
 * Read `docs/agents/demo-verification.md` for the subsystem map and ADR 0013
 * for why this adapter may not certify.
 */

export {
  PROTOCOL_ERROR_CODES,
  PROTOCOL_REFUSAL_EXIT_CODE,
  ProtocolAdapterError,
  type ProtocolAdapterErrorCode,
} from "./errors";

export {
  DEFAULT_CALL_TIMEOUT_MS,
  AGENT_QUIET_MS,
  AGENT_SPEECH_GAP_MS,
  LOCALE_VOICES,
  runProtocolCall,
  voiceForLocale,
  type ProtocolCallDeps,
} from "./transport";

export {
  DEFAULT_SOUNDSCAPE_LEVEL_DB,
  QUIET_SOUNDSCAPE,
  appliedFaults,
  callDropAtMs,
  decideUplinkFrame,
  mixSoundscape,
  soundscapeGain,
  type UplinkFrameDecision,
} from "./faults";

export {
  PROTOCOL_REQUIRED_KEYS,
  PROTOCOL_REQUIRED_LEGS,
  defaultVendorBuildsPath,
  preflight,
  readVendorBuilds,
} from "./refusals";

export {
  assembleEvidence,
  buildCards,
  cardInputs,
  requireSafeId,
  runDirectory,
  writeJson,
} from "./evidence";

export {
  runProtocolDiagnosis,
  runReplayCommand,
  type ProtocolRunInput,
} from "./runner";

export {
  DEFAULT_RUN_ROOT,
  DEFAULT_VENDOR_BUILDS_PATH,
  PROTOCOL_ADAPTER,
  PROTOCOL_RUN_SCHEMA_VERSION,
  PROTOCOL_RUN_STATUSES,
  type AppliedFault,
  type AssembledEvidence,
  type CardAttribution,
  type CardGap,
  type MissingItem,
  type ObservedTimeline,
  type ProtocolAdapter,
  type ProtocolCallAdapter,
  type ProtocolCallInput,
  type ProtocolCallRecord,
  type ProtocolCallResult,
  type ProtocolEvidenceBundle,
  type ProtocolPreflight,
  type ProtocolPreflightInput,
  type ProtocolRunRecord,
  type ProtocolRunResult,
  type ProtocolRunStatus,
  type ProtocolTarget,
  type ProtocolTargetLabel,
  type VendorBuildEntry,
  type VendorBuildRecord,
} from "./types";
