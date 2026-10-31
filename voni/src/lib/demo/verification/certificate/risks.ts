/**
 * The residual-risk register as the certificate cites it.
 *
 * The register's home is `docs/agents/demo-verification.md`; this file is the
 * machine-readable copy the validator checks ids against, and
 * `certificate.test.ts` fails if the two disagree. Ids are append-only and never
 * renumbered. An id absent here is a named refusal, and an open id the
 * certificate omits is refused too: a risk is only dropped when the docs record
 * its closure evidence.
 *
 * RR-01 and RR-07 always apply (accent coverage is TTS-only; held-out
 * scenarios are process-sealed). All eight are open as of the register's
 * version 1, so every certificate cites all eight.
 */

export type ResidualRisk = {
  readonly id: string;
  readonly owner: "owner" | "operator" | "engineer";
  readonly opened: string;
};

/** Register version 1, dated 2026-10-31. */
export const RESIDUAL_RISKS: readonly ResidualRisk[] = [
  {
    id: "RR-01",
    owner: "owner",
    opened: "2026-10-31",
  },
  {
    id: "RR-02",
    owner: "owner",
    opened: "2026-10-31",
  },
  {
    id: "RR-03",
    owner: "engineer",
    opened: "2026-10-31",
  },
  {
    id: "RR-04",
    owner: "owner",
    opened: "2026-10-31",
  },
  {
    id: "RR-05",
    owner: "operator",
    opened: "2026-10-31",
  },
  {
    id: "RR-06",
    owner: "operator",
    opened: "2026-10-31",
  },
  {
    id: "RR-07",
    owner: "engineer",
    opened: "2026-10-31",
  },
  {
    id: "RR-08",
    owner: "engineer",
    opened: "2026-10-31",
  },
];

export const RESIDUAL_RISK_IDS: readonly string[] = RESIDUAL_RISKS.map((risk) => risk.id);

/** Risks with no recorded closure; every certificate must carry these ids. */
export const OPEN_RESIDUAL_RISK_IDS: readonly string[] = [...RESIDUAL_RISK_IDS];

export function knownResidualRisk(id: string): ResidualRisk | undefined {
  return RESIDUAL_RISKS.find((risk) => risk.id === id);
}
