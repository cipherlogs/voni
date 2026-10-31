/**
 * The browser adapter: the certifying run on the real stack.
 *
 * One scenario runs once through a real Chromium on the real landing page, with
 * a synthetic microphone installed over `getUserMedia` before app code, a real
 * mint, the real client, pipeline, vendor legs, tools and test inbox. The
 * delivered WAV, browser marks, trace and end document are assembled into one
 * run directory, the verdict core judges them, and a certificate is written.
 *
 * Read `docs/agents/demo-verification.md` for the subsystem map and ADR 0013
 * for why this adapter, and only this adapter, may certify.
 */

export {
  BROWSER_ERROR_CODES,
  BROWSER_REFUSAL_EXIT_CODE,
  BrowserAdapterError,
  type BrowserAdapterErrorCode,
} from "./errors";

export {
  BROWSER_REQUIRED_LEGS,
  FAKE_PIPELINE_HOST,
  MARKS_PROBE_PATH,
  TEST_BUILD_ENV,
  defaultVendorBuildsPath,
  fakePipelineReason,
  isLoopbackHost,
  preflightBrowserRun,
  readVendorBuilds,
  refusalCodeFor,
  testBuildReason,
} from "./refusals";

export {
  assembleBrowserEvidence,
  buildCards,
  cardInputs,
  readWavFacts,
  requireSafeId,
  runDirectory,
  writeJson,
  type WavFacts,
} from "./evidence";

export {
  DEFAULT_BROWSER_CALL_TIMEOUT_MS,
  buildBrowserInvocation,
  readTakePcm,
  runPlaywrightBrowserCall,
} from "./call";

export {
  installSyntheticMic,
  readSyntheticMicReport,
  pcm16ToBase64,
  syntheticMicSource,
  type SyntheticMicPlay,
  type SyntheticMicTake,
} from "./synthetic-mic";

export {
  runBrowserCertification,
  runReplayCommand,
  defaultCapturesDir,
  type BrowserRunInput,
} from "./runner";

export {
  BROWSER_ADAPTER,
  BROWSER_PROJECT,
  BROWSER_RUN_SCHEMA_VERSION,
  BROWSER_RUN_STATUSES,
  BROWSER_SPEC,
  DEFAULT_BROWSER_RUN_ROOT,
  DEFAULT_CAPTURES_DIR,
  LANDING_PATH,
  type AppliedFault,
  type AssembledBrowserEvidence,
  type BrowserAdapter,
  type BrowserCallAdapter,
  type BrowserCallInput,
  type BrowserCallRecord,
  type BrowserCallResult,
  type BrowserCardGap,
  type BrowserEvidenceBundle,
  type BrowserParityRecord,
  type BrowserPreflight,
  type BrowserPreflightInput,
  type BrowserRunRecord,
  type BrowserRunResult,
  type BrowserRunStatus,
  type BrowserStackProbe,
  type BrowserStackProbeResponse,
  type BrowserTarget,
  type BrowserTargetLabel,
  type CardGap,
  type MissingItem,
  type ObservedTimeline,
  type SyntheticMicReport,
  type VendorBuildEntry,
  type VendorBuildRecord,
} from "./types";
