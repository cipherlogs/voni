/**
 * The clean-certification streak: three consecutive certificates on one code
 * fingerprint and one target support a release or cutover claim.
 *
 * A streak is the latest three committed certifications, in run-id order (the
 * writer's run id starts with its UTC timestamp, so it is the one clock the
 * whole directory shares). Every one of them must be `certified`, on a clean
 * tree, with no coverage gap, no run failure, full plan and the same code
 * fingerprint. A different target, a dirty tree, a coverage gap or a different
 * fingerprint breaks the claim by name; a non-clean run in the window is never
 * skipped.
 *
 * Spec: "one clean certification reports nightly health; three consecutive
 * clean certifications on the same code fingerprint support a release or
 * cutover claim."
 */

import type { CodeFingerprint } from "../../scoreboard";
import type { Certificate, CertificateTarget } from "../certificate";

export const STREAK_SIZE = 3;

export const STREAK_BREAK_CODES = [
  "no-certificates",
  "too-few",
  "different-target",
  "plan-not-full",
  "dirty-tree",
  "different-fingerprint",
  "not-certified",
  "ineligible",
  "coverage-gap",
  "run-failure",
  "resumed-run",
  "duplicate-run-id",
] as const;

export type StreakBreakCode = (typeof STREAK_BREAK_CODES)[number];

export type StreakBreak = {
  readonly code: StreakBreakCode;
  /** The certificate that breaks it; null when the whole window is short. */
  readonly runId: string | null;
  readonly detail: string;
};

export type CertificateStreak = {
  readonly ok: boolean;
  readonly target: CertificateTarget;
  /** Clean certificates in the window (at most {@link STREAK_SIZE}). */
  readonly count: number;
  readonly runIds: readonly string[];
  readonly fingerprint: CodeFingerprint | null;
  readonly breaks: readonly StreakBreak[];
  readonly detail: string;
};

function breakOf(
  code: StreakBreakCode,
  runId: string | null,
  detail: string,
): StreakBreak {
  return { code, runId, detail };
}

/**
 * A clean certification is one that may support a date claim: certified, not
 * dirty, fully covered, eligible, no run failure, a full plan and a panel
 * signature. H1-H5 remain the panel's; an unsigned certificate is not clean
 * enough to count.
 */
export function isCleanCertification(certificate: Certificate): boolean {
  return (
    certificate.verdict === "certified" &&
    certificate.pass &&
    certificate.panel !== null &&
    !certificate.code.fingerprint.dirty &&
    certificate.plan.mode === "full" &&
    certificate.coverage.gapRows === 0 &&
    // Every Locale inside the declared scope is measured; an out-of-scope
    // Locale is neutral by the owner's decision (RR-09), never a clean row it
    // did not earn. The validator already refused an out-of-scope row that ran.
    certificate.coverage.byLocale.every(
      (locale) => locale.status === "measured" || locale.status === "out-of-scope",
    ) &&
    certificate.eligibility.eligible &&
    certificate.runFailures.length === 0 &&
    // A certificate assembled across an interruption is not one clean run. It
    // may support a diagnosis, never a release or cutover streak.
    certificate.resume === null &&
    certificate.properties.every((property) => property.status !== "FAIL")
  );
}

function sameFingerprint(left: CodeFingerprint, right: CodeFingerprint): boolean {
  return (
    left.head === right.head &&
    left.dirtyHash === right.dirtyHash &&
    left.dirty === right.dirty
  );
}

/**
 * Judge the latest three certificates against one target. The order is the
 * committed run id, not file mtime: a copy or checkout stamps "now" on an old
 * certificate.
 */
export function evaluateCertificateStreak(input: {
  readonly certificates: readonly Certificate[];
  readonly target: CertificateTarget;
}): CertificateStreak {
  const breaks: StreakBreak[] = [];
  const ordered = [...input.certificates].sort((left, right) =>
    left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0,
  );
  const seen = new Set<string>();
  for (const certificate of ordered) {
    if (seen.has(certificate.runId)) {
      breaks.push(
        breakOf(
          "duplicate-run-id",
          certificate.runId,
          `certificate "${certificate.runId}" appears twice; a run id names one claim`,
        ),
      );
    }
    seen.add(certificate.runId);
  }

  const window = ordered.slice(-STREAK_SIZE);
  const runIds = window.map((certificate) => certificate.runId);
  const fingerprint =
    window.length === 0 ? null : { ...window[window.length - 1].code.fingerprint };

  if (window.length === 0) {
    breaks.push(breakOf("no-certificates", null, "no certificate is recorded"));
  } else if (window.length < STREAK_SIZE) {
    breaks.push(
      breakOf(
        "too-few",
        null,
        `${window.length} of ${STREAK_SIZE} clean certifications are recorded; a streak needs ${STREAK_SIZE}`,
      ),
    );
  }

  for (const certificate of window) {
    if (certificate.target !== input.target) {
      breaks.push(
        breakOf(
          "different-target",
          certificate.runId,
          `certificate "${certificate.runId}" is true for target "${certificate.target}", not ` +
            `"${input.target}"; a different target interrupts the sequence`,
        ),
      );
      continue;
    }
    if (fingerprint !== null && !sameFingerprint(certificate.code.fingerprint, fingerprint)) {
      breaks.push(
        breakOf(
          "different-fingerprint",
          certificate.runId,
          `certificate "${certificate.runId}" ran code ${certificate.code.fingerprint.head}` +
            `${certificate.code.fingerprint.dirty ? "+dirty" : ""}, not the streak's ` +
            `${fingerprint.head}${fingerprint.dirty ? "+dirty" : ""}`,
        ),
      );
    }
    if (certificate.code.fingerprint.dirty) {
      breaks.push(
        breakOf(
          "dirty-tree",
          certificate.runId,
          `certificate "${certificate.runId}" was measured on a dirty tree; a clean certification ` +
            "needs the committed code it names",
        ),
      );
    }
    if (certificate.plan.mode !== "full") {
      breaks.push(
        breakOf(
          "plan-not-full",
          certificate.runId,
          `certificate "${certificate.runId}" is a "${certificate.plan.mode}" run, not a full ` +
            "certification",
        ),
      );
    }
    if (!certificate.eligibility.eligible) {
      breaks.push(
        breakOf(
          "ineligible",
          certificate.runId,
          `certificate "${certificate.runId}" is ineligible: ` +
            `${certificate.eligibility.reasons.join("; ") || "no reason recorded"}`,
        ),
      );
    }
    if (certificate.coverage.gapRows > 0) {
      breaks.push(
        breakOf(
          "coverage-gap",
          certificate.runId,
          `certificate "${certificate.runId}" has ${certificate.coverage.gapRows} coverage gap row(s)`,
        ),
      );
    }
    if (certificate.runFailures.length > 0) {
      breaks.push(
        breakOf(
          "run-failure",
          certificate.runId,
          `certificate "${certificate.runId}" records run failures: ` +
            certificate.runFailures.join("; "),
        ),
      );
    }
    if (certificate.resume !== null) {
      breaks.push(
        breakOf(
          "resumed-run",
          certificate.runId,
          `certificate "${certificate.runId}" was assembled across an interruption ` +
            `(${certificate.resume.reusedCalls.length} reused + ` +
            `${certificate.resume.madeCalls.length} made call(s)); a clean certification is ` +
            "one uninterrupted run",
        ),
      );
    }
    if (certificate.verdict !== "certified" || !certificate.pass || certificate.panel === null) {
      const why =
        certificate.verdict !== "certified"
          ? `verdict "${certificate.verdict}"`
          : certificate.panel === null
            ? "no panel signature"
            : "pass is false";
      breaks.push(
        breakOf(
          "not-certified",
          certificate.runId,
          `certificate "${certificate.runId}" is not a clean certification (${why})`,
        ),
      );
    }
  }

  const broken = new Set(breaks.map((entry) => entry.runId));
  const count = window.filter(
    (certificate) => !broken.has(certificate.runId) && isCleanCertification(certificate),
  ).length;
  const ok =
    breaks.length === 0 &&
    window.length === STREAK_SIZE &&
    window.every(
      (certificate) =>
        certificate.target === input.target && isCleanCertification(certificate),
    );
  const detail = ok
    ? `${STREAK_SIZE} consecutive clean certifications on ${fingerprint?.head ?? "no code"} ` +
      `for target ${input.target} (${runIds.join(", ")})`
    : `no ${STREAK_SIZE}-clean streak for target ${input.target}: ` +
      (breaks.length === 0
        ? "the latest window is shorter than the streak"
        : breaks.map((entry) => `${entry.code}${entry.runId ? ` (${entry.runId})` : ""}`).join(", "));

  return {
    ok,
    target: input.target,
    count,
    runIds,
    fingerprint,
    breaks,
    detail,
  };
}
