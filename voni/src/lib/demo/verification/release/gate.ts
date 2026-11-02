/**
 * The cutover gate: a clean staging certificate for the same image plus a
 * three-certification streak opens the production routing flip.
 *
 * The gate never runs anything. It reads committed certificates, binds the
 * staging claim to the image about to be served, and refuses by name when the
 * claim is absent, unsigned, dirty, gapped or measured on another fingerprint.
 * A production certificate is refused as staging evidence — and a staging
 * certificate is refused as production evidence — so a green never inherits.
 *
 * Exit codes: 0 open, 1 blocked (evidence present but red), 2 bad input or
 * missing evidence, 3 pending-human (the panel or the baseline is not done).
 *
 * Spec: "a clean staging certificate for the same image gates the production
 * routing flip"; ADR 0013; RR-05.
 */

import {
  CertificateError,
  validateCertificate,
  type Certificate,
  type CertificateTarget,
} from "../certificate";
import type { Locale } from "../scenarios";
import { evaluateCertificateStreak, isCleanCertification, STREAK_SIZE } from "./streak";

export type CutoverGateCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly code: string;
  readonly detail: string;
  readonly source: string;
};

export type CutoverGateResult = {
  readonly open: boolean;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly image: string;
  readonly stagingRunId: string | null;
  /** The Locale set the staging streak is true for; null when absent/mixed. */
  readonly scope: readonly Locale[] | null;
  readonly checks: readonly CutoverGateCheck[];
  /** Named evidence that is absent; empty when the gate opens. */
  readonly missing: readonly string[];
  readonly detail: string;
};

function check(
  name: string,
  ok: boolean,
  code: string,
  detail: string,
  source: string,
): CutoverGateCheck {
  return { name, ok, code, detail, source };
}

function newest(certificates: readonly Certificate[]): Certificate | null {
  if (certificates.length === 0) return null;
  const ordered = [...certificates].sort((left, right) =>
    left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0,
  );
  return ordered[ordered.length - 1];
}

/**
 * Production evidence must be a production certificate. The validator refuses
 * a staging certificate read under the production expectation by name.
 */
export function assertProductionCertificate(
  certificate: Certificate,
  expectation: Parameters<typeof validateCertificate>[1] = {},
): Certificate {
  return validateCertificate(certificate, { ...expectation, target: "production" });
}

/**
 * Judge the gate for one image. The image is the one about to be served; a
 * certificate for another image is not evidence for this flip.
 */
export function evaluateCutoverGate(input: {
  readonly image: string;
  readonly certificates: readonly Certificate[];
  /** Optional claimed fingerprint; a staging certificate on another code is refused. */
  readonly fingerprint?: Certificate["code"]["fingerprint"];
}): CutoverGateResult {
  const image = input.image.trim();
  if (image === "") {
    return {
      open: false,
      exitCode: 2,
      image,
      stagingRunId: null,
      scope: null,
      checks: [check("image", false, "missing-image", "the gate needs the image being flipped", "cutover gate")],
      missing: ["the image being flipped"],
      detail: "missing-evidence: no image was named for the cutover gate",
    };
  }

  const staging = input.certificates.filter(
    (certificate) =>
      certificate.target === "staging" && certificate.code.pipelineImage === image,
  );
  const chosen = newest(staging);

  if (chosen === null) {
    const missing = [
      `staging certificate for image ${image}`,
      `${STREAK_SIZE} consecutive clean staging certifications on that image`,
    ];
    return {
      open: false,
      exitCode: 2,
      image,
      stagingRunId: null,
      scope: null,
      checks: [
        check(
          "staging-certificate",
          false,
          "missing-staging-certificate",
          `no committed staging certificate names image ${image}; the production flip has no ` +
            "staging evidence for the image it would serve",
          "voni/evidence/certificates",
        ),
      ],
      missing,
      detail: `missing-evidence: ${missing.join("; ")}`,
    };
  }

  const checks: CutoverGateCheck[] = [
    check(
      "staging-certificate",
      true,
      "staging-certificate",
      `staging certificate ${chosen.runId} is for image ${image}`,
      "voni/evidence/certificates",
    ),
  ];
  const missing: string[] = [];

  if (input.fingerprint !== undefined) {
    const same =
      input.fingerprint.head === chosen.code.fingerprint.head &&
      input.fingerprint.dirtyHash === chosen.code.fingerprint.dirtyHash;
    checks.push(
      check(
        "fingerprint",
        same,
        same ? "same-fingerprint" : "code-fingerprint-mismatch",
        same
          ? `staging certificate ran code ${chosen.code.fingerprint.head}`
          : `staging certificate ran ${chosen.code.fingerprint.head}, not the claimed ` +
            input.fingerprint.head,
        "certificate.code.fingerprint",
      ),
    );
    if (!same) {
      missing.push(`staging certificate on code ${input.fingerprint.head} for image ${image}`);
    }
  }

  if (chosen.verdict === "pending-human") {
    checks.push(
      check(
        "panel",
        false,
        "pending-human",
        `staging certificate ${chosen.runId} is pending-human: the panel signature is absent`,
        "certificate.panel",
      ),
    );
    return {
      open: false,
      exitCode: 3,
      image,
      stagingRunId: chosen.runId,
      scope: chosen.scope?.locales ?? null,
      checks,
      missing,
      detail:
        `pending-human: staging certificate ${chosen.runId} is unsigned; the owner's panel and ` +
        "the human baseline are the gate (ticket 25/27), not a green",
    };
  }

  const clean =
    isCleanCertification(chosen) && chosen.code.pipelineImage === image;
  checks.push(
    check(
      "staging-clean",
      clean,
      clean ? "staging-clean" : "staging-not-clean",
      clean
        ? `staging certificate ${chosen.runId} is certified, fully covered and on a clean tree`
        : `staging certificate ${chosen.runId} is ${chosen.verdict} (${chosen.coverage.gapRows} gap ` +
          `row(s), ${chosen.code.fingerprint.dirty ? "dirty tree" : "clean tree"})` +
          (chosen.resume === null
            ? ""
            : "; it was assembled across an interruption, not one clean run"),
      "certificate.verdict",
    ),
  );

  const stagingCertificates = input.certificates.filter(
    (certificate) => certificate.target === "staging",
  );
  const streak = evaluateCertificateStreak({
    certificates: stagingCertificates,
    target: "staging",
  });
  checks.push(
    check(
      "staging-streak",
      streak.ok,
      streak.ok ? "streak-clean" : streak.count < STREAK_SIZE ? "streak-short" : "streak-broken",
      streak.detail,
      "voni/evidence/certificates",
    ),
  );
  if (!streak.ok && streak.count < STREAK_SIZE) {
    missing.push(
      `${STREAK_SIZE} consecutive clean staging certifications on code ` +
        `${chosen.code.fingerprint.head} (found ${streak.count})`,
    );
  }

  checks.push(
    check(
      "production-inheritance",
      true,
      "own-certificate-required",
      "production requires its own certificate and confirmation; the staging green is never inherited",
      "ADR 0013; RR-05",
    ),
  );

  const failed = checks.filter((entry) => !entry.ok);
  const exitCode: CutoverGateResult["exitCode"] =
    failed.length === 0 ? 0 : streak.count < STREAK_SIZE && clean ? 2 : 1;
  const open = exitCode === 0;
  const scopeNote = streak.scope === null ? "" : ` on scope ${streak.scope.join(", ")}`;
  const detail = open
    ? `gate open: staging ${chosen.runId} certifies image ${image} on ` +
      `${chosen.code.fingerprint.head}, with a ${STREAK_SIZE}-clean staging streak${scopeNote}`
    : failed.length > 0
      ? `${exitCode === 2 ? "missing-evidence" : "blocked"}: ` +
        failed.map((entry) => `${entry.code}: ${entry.detail}`).join("; ")
      : `blocked: staging certificate ${chosen.runId} does not certify image ${image}`;

  return {
    open,
    exitCode,
    image,
    stagingRunId: chosen.runId,
    scope: streak.scope,
    checks,
    missing,
    detail,
  };
}

/** The one target a gate result can open for; exported for the CLI contract. */
export const CUTOVER_TARGET: CertificateTarget = "production";

/** Re-exported so a CLI can turn a certificate error into a named refusal. */
export { CertificateError };
