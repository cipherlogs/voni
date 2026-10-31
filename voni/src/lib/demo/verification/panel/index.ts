/**
 * Panel and gold labels: the human gate for H1-H5/H7 and the signature that
 * completes a certificate.
 *
 * The session builder, the Studio export and the signing CLI live under
 * `voni/scripts/studio/panel/` because the Studio is a local-only script
 * process and nothing under `voni/src/` may import it. This module is the pure
 * vocabulary and the verdict the certificate reads.
 */

export {
  PANEL_SAMPLE_SIZE,
  PANEL_CALLS_PER_LOCALE,
  PANEL_STAY_YES_MIN,
  PANEL_SIGNATURE_PREFIX,
  type PanelGoldLabel,
  type PanelGoldLabelSet,
  type PanelJudgementInput,
} from "./types";

export { PanelError, PANEL_REFUSAL_EXIT_CODE, type PanelErrorCode } from "./errors";
export { judgePanel } from "./verdict";
export { applyPanelVerdict } from "./run";
