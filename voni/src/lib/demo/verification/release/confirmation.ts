/**
 * The post-flip production confirmation: a short recorded run after the
 * routing flip, bound to the staging certificate that gated it.
 *
 * It is not a certificate and never becomes one. It runs the fast contract's
 * ten-call core on production, records the calls and the evidence directory,
 * and proves the deployed stack answers. The monthly full production
 * certification is the claim's backstop (RR-05), so the confirmation may be
 * short; a record longer than {@link POST_FLIP_MAX_CALLS} is refused by name
 * rather than allowed to drift into a second certification.
 */

import { LOCALES } from "../scenarios";
import { ReleaseError } from "./errors";

/** The fast contract's ten-call core: a post-flip check, never a full run. */
export const POST_FLIP_MAX_CALLS = 10;

export type PostFlipCall = {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: "en" | "es" | "fr" | "de" | "pt";
};

export type PostFlipConfirmation = {
  readonly schemaVersion: 1;
  readonly target: "production";
  readonly image: string;
  readonly runId: string;
  /** The staging certificate this flip was gated on; a confirmation never floats. */
  readonly stagingCertificateRunId: string;
  readonly flippedAt: string;
  readonly confirmedAt: string;
  readonly calls: readonly PostFlipCall[];
  readonly verdict: "passed" | "failed";
  readonly evidence: readonly string[];
  readonly detail: string;
};

export type PostFlipEvaluation = {
  readonly ok: boolean;
  readonly exitCode: 0 | 1 | 2;
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly code: string;
    readonly detail: string;
  }[];
  readonly detail: string;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReleaseError("invalid-record", "a post-flip confirmation is an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleaseError("invalid-record", `post-flip confirmation ${field} must be a non-empty string`);
  }
  return value;
}

function iso(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new ReleaseError("invalid-record", `post-flip confirmation ${field} "${parsed}" is not a date`);
  }
  return parsed;
}

function call(value: unknown, index: number): PostFlipCall {
  const entry = record(value);
  const locale = text(entry.locale, `calls[${index}].locale`);
  if (!(LOCALES as readonly string[]).includes(locale)) {
    throw new ReleaseError(
      "invalid-record",
      `post-flip call ${index} Locale "${locale}" is not one of ${LOCALES.join(", ")}`,
    );
  }
  return {
    callId: text(entry.callId, `calls[${index}].callId`),
    scenario: text(entry.scenario, `calls[${index}].scenario`),
    locale: locale as PostFlipCall["locale"],
  };
}

/** Parse one committed confirmation; an unknown target or shape is refused. */
export function parsePostFlipConfirmation(raw: unknown): PostFlipConfirmation {
  const entry = record(raw);
  if (entry.schemaVersion !== 1) {
    throw new ReleaseError(
      "invalid-record",
      `post-flip confirmation schema version ${String(entry.schemaVersion)} is not 1`,
    );
  }
  if (entry.target !== "production") {
    throw new ReleaseError(
      "wrong-target",
      `post-flip confirmation target is "${String(entry.target)}", not production; a staging ` +
        "confirmation is not a production one",
    );
  }
  if (!Array.isArray(entry.calls)) {
    throw new ReleaseError("invalid-record", "post-flip confirmation calls is not an array");
  }
  if (!Array.isArray(entry.evidence)) {
    throw new ReleaseError("invalid-record", "post-flip confirmation evidence is not an array");
  }
  if (entry.verdict !== "passed" && entry.verdict !== "failed") {
    throw new ReleaseError(
      "invalid-record",
      `post-flip confirmation verdict is "${String(entry.verdict)}", not passed or failed`,
    );
  }
  return {
    schemaVersion: 1,
    target: "production",
    image: text(entry.image, "image"),
    runId: text(entry.runId, "runId"),
    stagingCertificateRunId: text(entry.stagingCertificateRunId, "stagingCertificateRunId"),
    flippedAt: iso(entry.flippedAt, "flippedAt"),
    confirmedAt: iso(entry.confirmedAt, "confirmedAt"),
    calls: entry.calls.map(call),
    verdict: entry.verdict,
    evidence: entry.evidence.map((value, index) => text(value, `evidence[${index}]`)),
    detail: text(entry.detail, "detail"),
  };
}

/** Judge a confirmation against the image and the staging gate it followed. */
export function evaluatePostFlipConfirmation(
  confirmation: PostFlipConfirmation,
  expected: { readonly image: string; readonly stagingCertificateRunId: string },
): PostFlipEvaluation {
  const checks: { name: string; ok: boolean; code: string; detail: string }[] = [];
  const add = (name: string, ok: boolean, code: string, detail: string): void => {
    checks.push({ name, ok, code, detail });
  };

  add(
    "target",
    confirmation.target === "production",
    "production",
    `confirmation ${confirmation.runId} ran on production`,
  );
  const sameImage = confirmation.image === expected.image;
  add(
    "image",
    sameImage,
    sameImage ? "same-image" : "image-mismatch",
    sameImage
      ? `confirmation ran image ${confirmation.image}`
      : `confirmation ran image ${confirmation.image}, not ${expected.image}`,
  );
  const sameGate = confirmation.stagingCertificateRunId === expected.stagingCertificateRunId;
  add(
    "staging-gate",
    sameGate,
    sameGate ? "same-staging-certificate" : "staging-certificate-mismatch",
    sameGate
      ? `confirmation follows staging certificate ${confirmation.stagingCertificateRunId}`
      : `confirmation follows staging certificate ${confirmation.stagingCertificateRunId}, not ` +
        expected.stagingCertificateRunId,
  );
  const short = confirmation.calls.length > 0 && confirmation.calls.length <= POST_FLIP_MAX_CALLS;
  add(
    "short",
    short,
    short ? "short" : "not-short",
    short
      ? `confirmation made ${confirmation.calls.length} calls (<= ${POST_FLIP_MAX_CALLS})`
      : `confirmation made ${confirmation.calls.length} calls; a post-flip check is at most ` +
        `${POST_FLIP_MAX_CALLS} and a longer run is a certification, not a confirmation`,
  );
  const passed = confirmation.verdict === "passed";
  add(
    "passed",
    passed,
    passed ? "passed" : "failed",
    passed ? "confirmation passed" : "confirmation failed; roll back through the routing switch",
  );

  const failed = checks.filter((entry) => !entry.ok);
  const exitCode: PostFlipEvaluation["exitCode"] = failed.length === 0 ? 0 : passed ? 2 : 1;
  const detail =
    failed.length === 0
      ? `post-flip confirmation ${confirmation.runId} passed ${confirmation.calls.length} calls on ` +
        `image ${confirmation.image}`
      : `${passed ? "missing-evidence" : "blocked"}: ` +
        failed.map((entry) => `${entry.code}: ${entry.detail}`).join("; ");
  return { ok: failed.length === 0, exitCode, checks, detail };
}
