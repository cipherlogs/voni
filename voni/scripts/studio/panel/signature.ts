/**
 * The signing path: `demo:certificate --panel <session-id> --reviewer <name>`.
 *
 * The owner's signature binds one panel session's gold labels to one
 * certificate. Signing refuses a session from a different run or target, a
 * missing or different reviewer, a missing or different date, an incomplete
 * panel and an already-signed or non-pending certificate — each by name. The
 * attestation is a digest over the certificate identity, the session identity
 * and the exact gold labels; verification recomputes it and refuses a changed
 * label or a forged signature string.
 *
 * The signature is an attestation, not a secret-key signature: the repository
 * holds no owner private key, and inventing one would make the claim less
 * honest. What it proves is that these exact labels, for this exact run, were
 * named by this reviewer on this date, and nothing was edited afterwards.
 */

import { timingSafeEqual } from "node:crypto";

import type { Certificate, CertificateProperty, PanelSignature } from "../../../src/lib/demo/verification/certificate/types";
import {
  deriveCertificateVerdict,
} from "../../../src/lib/demo/verification/certificate/derive";
import { validateCertificate } from "../../../src/lib/demo/verification/certificate/validate";
import { PanelError } from "../../../src/lib/demo/verification/panel/errors";
import {
  PANEL_SIGNATURE_PREFIX,
  type PanelGoldLabelSet,
} from "../../../src/lib/demo/verification/panel/types";
import type { RatingRecord, RatingSession } from "../rate";
import { sha256Hex } from "../../../src/lib/demo/verification/scenarios/digest";
import { exportGoldLabels, goldLabelDigest } from "./gold-labels";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SIGNATURE = new RegExp(`^${PANEL_SIGNATURE_PREFIX}[0-9a-f]{64}$`);

function refuse(code: ConstructorParameters<typeof PanelError>[0], message: string): never {
  throw new PanelError(code, message);
}

function requireDate(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    refuse("missing-signature-date", `${what} is missing; a signature is always dated`);
  }
  const date = value.trim();
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date))) {
    refuse("invalid-signature-date", `${what} "${date}" is not a YYYY-MM-DD date`);
  }
  return date;
}

function signDigest(input: {
  certificate: Certificate;
  signature: Pick<PanelSignature, "sessionId" | "reviewer" | "signedAt">;
  labels: PanelGoldLabelSet;
}): string {
  return `${PANEL_SIGNATURE_PREFIX}${sha256Hex(
    JSON.stringify({
      version: 1,
      certificate: {
        runId: input.certificate.runId,
        target: input.certificate.target,
        corpus: {
          version: input.certificate.corpus.version,
          sha256: input.certificate.corpus.sha256,
        },
        code: {
          head: input.certificate.code.fingerprint.head,
          dirty: input.certificate.code.fingerprint.dirty,
          dirtyHash: input.certificate.code.fingerprint.dirtyHash,
        },
      },
      panel: {
        sessionId: input.signature.sessionId,
        reviewer: input.signature.reviewer,
        signedAt: input.signature.signedAt,
      },
      labels: goldLabelDigest({
        sessionId: input.labels.sessionId,
        runId: input.labels.runId,
        reviewer: input.labels.reviewer,
        signedAt: input.labels.signedAt,
        labels: input.labels.labels,
      }),
    }),
  )}`;
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type SignPanelInput = {
  readonly certificate: Certificate;
  readonly session: RatingSession;
  readonly ratings: readonly RatingRecord[];
  readonly reviewer: string;
  /** Defaults to the session date; a different date is refused, never backdated. */
  readonly signedAt?: string;
};

/**
 * Produce the owner's signature. This does not write anything; the CLI and the
 * certificate completion helper do.
 */
export function signPanel(input: SignPanelInput): PanelSignature {
  const { certificate, session } = input;
  if (certificate.panel !== null) {
    refuse(
      "already-signed",
      `certificate "${certificate.runId}" is already signed by ${certificate.panel.reviewer} ` +
        `on ${certificate.panel.signedAt}; a signature is written once`,
    );
  }
  if (certificate.verdict !== "pending-human") {
    refuse(
      "certificate-not-pending",
      `certificate "${certificate.runId}" is "${certificate.verdict}", not pending-human; ` +
        "only a clean unsigned certificate may be signed",
    );
  }
  if (typeof input.reviewer !== "string" || input.reviewer.trim() === "") {
    refuse(
      "missing-reviewer",
      "a signature needs the reviewer's name; the owner signs as a person, never anonymously",
    );
  }
  const reviewer = input.reviewer.trim();
  if (reviewer !== session.reviewer) {
    refuse(
      "reviewer-mismatch",
      `"${reviewer}" cannot sign session "${session.sessionId}": the session belongs to ` +
        `"${session.reviewer}"`,
    );
  }
  if (session.runId !== certificate.runId) {
    refuse(
      "run-mismatch",
      `session "${session.sessionId}" belongs to run "${session.runId}", not certificate run ` +
        `"${certificate.runId}"; a panel never signs another run's certificate`,
    );
  }
  if (session.target !== certificate.target) {
    refuse(
      "target-mismatch",
      `session "${session.sessionId}" is for target "${session.target}", not certificate target ` +
        `"${certificate.target}"`,
    );
  }
  const signedAt = requireDate(input.signedAt ?? session.date, "signature date");
  if (signedAt !== session.date) {
    refuse(
      "date-mismatch",
      `signature date "${signedAt}" differs from the panel session date "${session.date}"; ` +
        "a signature is made on the day the panel was rated",
    );
  }
  const labels = exportGoldLabels({ session, ratings: input.ratings });
  if (labels.runId !== certificate.runId) {
    refuse(
      "run-mismatch",
      `gold labels belong to run "${labels.runId}", not "${certificate.runId}"`,
    );
  }
  if (!certificate.properties.some((property) => property.propertyId === "H7")) {
    refuse(
      "missing-panel-property",
      `certificate "${certificate.runId}" carries no H7 property; the signature has nowhere to land`,
    );
  }
  const signature = signDigest({ certificate, signature: { sessionId: session.sessionId, reviewer, signedAt }, labels });
  return { sessionId: session.sessionId, reviewer, signedAt, signature };
}

export type VerifyPanelInput = {
  readonly certificate: Certificate;
  readonly session: RatingSession;
  readonly ratings: readonly RatingRecord[];
  /** Defaults to the certificate's own panel; a missing signature is refused. */
  readonly signature?: PanelSignature;
};

/** Verify the certificate's own signature against the session and its labels. */
export function verifyPanelSignature(input: VerifyPanelInput): { verified: true; digest: string } {
  const signature = input.signature ?? input.certificate.panel;
  if (signature === null || signature === undefined) {
    refuse(
      "missing-signature",
      `certificate "${input.certificate.runId}" carries no panel signature; an unsigned ` +
        "certificate is pending-human, never certified",
    );
  }
  if (!SIGNATURE.test(signature.signature)) {
    refuse(
      "invalid-signature",
      `panel signature "${signature.signature}" is not ${PANEL_SIGNATURE_PREFIX}<64 hex>`,
    );
  }
  if (signature.sessionId !== input.session.sessionId) {
    refuse(
      "signature-mismatch",
      `the signature names session "${signature.sessionId}", not "${input.session.sessionId}"`,
    );
  }
  const labels = exportGoldLabels({ session: input.session, ratings: input.ratings });
  const expected = signDigest({
    certificate: input.certificate,
    signature: {
      sessionId: signature.sessionId,
      reviewer: signature.reviewer,
      signedAt: signature.signedAt,
    },
    labels,
  });
  if (!same(expected, signature.signature)) {
    refuse(
      "signature-mismatch",
      `the panel signature does not match certificate "${input.certificate.runId}", session ` +
        `"${signature.sessionId}" and its gold labels; the labels or the claim changed after signing`,
    );
  }
  return { verified: true, digest: labels.digest };
}

/**
 * Complete an unsigned certificate with the owner's signature. H7 is the one
 * property the signature changes; every other verdict is untouched, and the
 * completed document is passed through the shared validator.
 */
export function completeCertificateSignature(
  certificate: Certificate,
  signature: PanelSignature,
  labels: PanelGoldLabelSet,
): Certificate {
  if (certificate.panel !== null) {
    refuse(
      "already-signed",
      `certificate "${certificate.runId}" already carries a panel signature`,
    );
  }
  const expected = signDigest({
    certificate,
    signature: {
      sessionId: signature.sessionId,
      reviewer: signature.reviewer,
      signedAt: signature.signedAt,
    },
    labels,
  });
  if (!same(expected, signature.signature)) {
    refuse(
      "signature-mismatch",
      `the signature does not attest certificate "${certificate.runId}", session ` +
        `"${signature.sessionId}" and the supplied gold labels; a certificate is never completed ` +
        "with an unverified attestation",
    );
  }
  if (
    labels.sessionId !== signature.sessionId ||
    labels.reviewer !== signature.reviewer ||
    labels.signedAt !== signature.signedAt
  ) {
    refuse(
      "signature-mismatch",
      "the gold labels' session, reviewer or date differ from the signature",
    );
  }
  const h7 = certificate.properties.find((property) => property.propertyId === "H7");
  if (h7 === undefined) {
    refuse(
      "missing-panel-property",
      `certificate "${certificate.runId}" carries no H7 property`,
    );
  }
  const signedH7: CertificateProperty = {
    ...h7,
    status: "PASS",
    reason: "pass",
    sampleCount: 1,
    citations: [`panel:signature:${signature.sessionId}`],
  };
  const properties = certificate.properties.map((property) =>
    property.propertyId === "H7" ? signedH7 : property,
  );
  const verdict = deriveCertificateVerdict({
    eligibility: certificate.eligibility,
    properties,
    runFailures: certificate.runFailures,
    coverage: certificate.coverage,
    panel: signature,
  });
  const completed: Certificate = {
    ...certificate,
    properties,
    panel: signature,
    verdict,
    pass: verdict === "certified",
  };
  return validateCertificate(completed);
}
