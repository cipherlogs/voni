/**
 * Panel orchestration for the local Studio: session assembly, gold-label
 * export and the owner's signature. The pure vocabulary and H1-H5/H7 gate live
 * in `voni/src/lib/demo/verification/panel/`.
 */

export { buildPanelSession, type BuildPanelSessionInput, type PanelSession } from "./session";
export { exportGoldLabels, goldLabelDigest, mergeGoldLabelSets } from "./gold-labels";
export {
  completeCertificateSignature,
  signPanel,
  verifyPanelSignature,
  type SignPanelInput,
  type VerifyPanelInput,
} from "./signature";
