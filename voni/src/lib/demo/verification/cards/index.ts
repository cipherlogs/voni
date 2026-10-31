/**
 * Defect cards: one card per failed property, rendered from the same verdicts
 * the certificate reads.
 *
 * The one parser in `replay.ts` is the contract the runner (ticket 11) and the
 * CLI (ticket 28) must accept unchanged: a card's replay line reproduces its
 * scenario, target and Locale in diagnosis mode.
 *
 * Read `docs/agents/demo-verification.md` for the subsystem map and ADR 0013
 * for the decisions this module enforces.
 */

export {
  DEFECT_CARD_ERROR_CODES,
  DefectCardError,
  type DefectCardErrorCode,
} from "./errors";

export {
  CARD_TARGETS,
  EXCERPT_MEDIA,
  SEVERITIES,
  type AudioExcerpt,
  type BuildDefectCardsInput,
  type CallEvidence,
  type CardTarget,
  type DefectAttribution,
  type DefectCard,
  type DefectCardCitation,
  type DefectCardExpectedBar,
  type DefectCardObserved,
  type ExcerptMedia,
  type Severity,
  type TurnEvidence,
} from "./types";

export { SEVERITY_RANK, severityFor } from "./severity";

export { wavDurationMs } from "./wav";

export {
  REPLAY_MODE,
  REPLAY_PROGRAM,
  parseReplayCommand,
  replayCommand,
  type ReplayInvocation,
  type ReplayReference,
} from "./replay";

export { buildDefectCards } from "./build";

export { renderDefectCard, renderDefectCards } from "./render";
