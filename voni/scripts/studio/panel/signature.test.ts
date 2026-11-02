/**
 * The signing path: an unsigned certificate is pending-human (exit 3); the
 * owner's signature completes it; a different run, a missing or different
 * reviewer, a missing date, an incomplete panel and a changed label are each a
 * named refusal.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  certificateExitCode,
  parseCertificate,
  serializeCertificate,
  validateCertificate,
  type Certificate,
} from "../../../src/lib/demo/verification/certificate";
import { PanelError } from "../../../src/lib/demo/verification/panel/errors";
import { main } from "../../lib/demo-certificate";
import {
  completeCertificateSignature,
  signPanel,
  verifyPanelSignature,
} from "./signature";
import { loadHumanContract, pendingSigningFixture, REVIEWER, SESSION_DATE } from "./fixtures";

function refusal(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof PanelError, `expected PanelError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2);
    return true;
  };
}

function studioRoot(session: unknown, ratings: readonly unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "panel-sign-"));
  const sessionId = (session as { sessionId: string }).sessionId;
  const dir = join(root, "sessions", sessionId);
  mkdirSync(join(dir, "ratings"), { recursive: true });
  writeFileSync(join(dir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  for (const rating of ratings) {
    const itemId = (rating as { itemId: string }).itemId;
    writeFileSync(join(dir, "ratings", `${itemId}.json`), `${JSON.stringify(rating, null, 2)}\n`, "utf8");
  }
  return root;
}

test("an unsigned certificate is pending-human, exits 3 and is never certified", async () => {
  const { certificate } = await pendingSigningFixture();
  assert.equal(certificate.verdict, "pending-human");
  assert.equal(certificate.pass, false);
  assert.equal(certificate.panel, null);
  assert.equal(certificateExitCode(certificate.verdict), 3);
  assert.doesNotThrow(() => validateCertificate(certificate));

  const forged = { ...certificate, verdict: "certified", pass: true } as Certificate;
  assert.throws(
    () => validateCertificate(forged),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no panel signature|unsigned certificate/);
      return true;
    },
  );
});

test("the owner's signature and the real one-session labels name H2 unmeasured, never exit 0", async () => {
  const { certificate, session, ratings, gold } = await pendingSigningFixture();
  const contract = await loadHumanContract();
  const signature = signPanel({ certificate, session, ratings, reviewer: REVIEWER });
  assert.equal(signature.sessionId, session.sessionId);
  assert.equal(signature.reviewer, REVIEWER);
  assert.equal(signature.signedAt, SESSION_DATE);
  assert.match(signature.signature, /^panel-v1:[0-9a-f]{64}$/);

  const completed = completeCertificateSignature(certificate, signature, gold, contract);
  assert.equal(completed.verdict, "not-demo-ready");
  assert.equal(completed.pass, false);
  assert.deepEqual(completed.panel, signature);
  assert.equal(certificateExitCode(completed.verdict), 1);

  const h2 = completed.properties.find((property) => property.propertyId === "H2");
  assert.equal(h2?.status, "FAIL");
  assert.equal(h2?.reason, "unmeasured");
  assert.match(
    h2?.gaps.join(" ") ?? "",
    /one panel session exports 12 A\/B judgments; the floor is 40/,
  );
  assert.equal(h2?.sampleCount, 12);

  // The English scope reaches the signing judge: H1 is not read as four missing
  // Locales, so the only human-property failure is the unreachable H2 floor.
  const h1 = completed.properties.find((property) => property.propertyId === "H1");
  assert.equal(h1?.status, "PASS", h1?.detail);
  assert.equal(completed.properties.find((property) => property.propertyId === "H7")?.status, "PASS");
  assert.doesNotThrow(() => verifyPanelSignature({ certificate: completed, session, ratings }));

  const roundTrip = parseCertificate(serializeCertificate(completed));
  assert.deepEqual(roundTrip.panel, signature);
  assert.equal(roundTrip.verdict, "not-demo-ready");
});

test("signing an English-only certificate judges H1 over en, not over four missing Locales", async () => {
  const { certificate, session, ratings, gold } = await pendingSigningFixture(["en"]);
  assert.deepEqual(certificate.scope?.locales, ["en"]);
  const contract = await loadHumanContract();
  const signature = signPanel({ certificate, session, ratings, reviewer: REVIEWER });
  const completed = completeCertificateSignature(certificate, signature, gold, contract);

  const h1 = completed.properties.find((property) => property.propertyId === "H1");
  assert.equal(h1?.status, "PASS", h1?.detail);
  assert.doesNotMatch(h1?.detail ?? "", /no panel label for Locale\(s\) es/);
  const h2 = completed.properties.find((property) => property.propertyId === "H2");
  assert.equal(h2?.reason, "unmeasured");
  assert.match(
    h2?.gaps.join(" ") ?? "",
    /one panel session exports 12 A\/B judgments; the floor is 40/,
  );
  assert.equal(completed.verdict, "not-demo-ready");
  assert.equal(certificateExitCode(completed.verdict), 1);
});

test("signing a different run is refused by name", async () => {
  const { certificate, session, ratings } = await pendingSigningFixture();
  assert.throws(
    () =>
      signPanel({
        certificate,
        session: { ...session, runId: "another-run" },
        ratings,
        reviewer: REVIEWER,
      }),
    refusal("run-mismatch", /another-run/),
  );
});

test("a missing reviewer, a different reviewer and a missing date are refused by name", async () => {
  const { certificate, session, ratings } = await pendingSigningFixture();
  assert.throws(
    () => signPanel({ certificate, session, ratings, reviewer: "  " }),
    refusal("missing-reviewer", /reviewer's name/),
  );
  assert.throws(
    () => signPanel({ certificate, session, ratings, reviewer: "someone-else" }),
    refusal("reviewer-mismatch", /cannot sign session/),
  );
  assert.throws(
    () =>
      signPanel({
        certificate,
        session: { ...session, date: "" },
        ratings,
        reviewer: REVIEWER,
      }),
    refusal("missing-signature-date", /always dated/),
  );
  assert.throws(
    () =>
      signPanel({
        certificate,
        session,
        ratings,
        reviewer: REVIEWER,
        signedAt: "2026-11-01",
      }),
    refusal("date-mismatch", /differs from the panel session date/),
  );
});

test("an incomplete panel and an already-signed certificate are refused", async () => {
  const { certificate, session, ratings, gold } = await pendingSigningFixture();
  assert.throws(
    () => signPanel({ certificate, session, ratings: ratings.slice(1), reviewer: REVIEWER }),
    refusal("incomplete-panel", /missing ratings for/),
  );

  const signature = signPanel({ certificate, session, ratings, reviewer: REVIEWER });
  const signed = completeCertificateSignature(certificate, signature, gold);
  assert.throws(
    () => signPanel({ certificate: signed, session, ratings, reviewer: REVIEWER }),
    refusal("already-signed", /already signed/),
  );
});

test("a non-pending certificate cannot be signed", async () => {
  const { certificate, session, ratings } = await pendingSigningFixture();
  const notReady = { ...certificate, verdict: "not-demo-ready" } as Certificate;
  assert.throws(
    () => signPanel({ certificate: notReady, session, ratings, reviewer: REVIEWER }),
    refusal("certificate-not-pending", /not pending-human/),
  );
});

test("verification refuses a changed signature and changed gold labels", async () => {
  const { certificate, session, ratings, gold } = await pendingSigningFixture();
  const signature = signPanel({ certificate, session, ratings, reviewer: REVIEWER });
  const completed = completeCertificateSignature(certificate, signature, gold);

  assert.throws(
    () =>
      verifyPanelSignature({
        certificate: completed,
        session,
        ratings,
        signature: { ...signature, signature: "panel-v1:" + "0".repeat(64) },
      }),
    refusal("signature-mismatch", /does not match/),
  );

  const changed = ratings.map((rating, index) =>
    index === 0 ? { ...rating, axes: { ...rating.axes, warmth: 2 } } : rating,
  );
  assert.throws(
    () => verifyPanelSignature({ certificate: completed, session, ratings: changed }),
    refusal("signature-mismatch", /gold labels/),
  );
});

test("a forged attestation or changed labels cannot complete a certificate", async () => {
  const { certificate, session, ratings, gold } = await pendingSigningFixture();
  const signature = signPanel({ certificate, session, ratings, reviewer: REVIEWER });
  assert.throws(
    () =>
      completeCertificateSignature(
        certificate,
        { ...signature, signature: "panel-v1:" + "0".repeat(64) },
        gold,
      ),
    refusal("signature-mismatch", /unverified attestation/),
  );
  assert.throws(
    () =>
      completeCertificateSignature(
        certificate,
        { ...signature, reviewer: "mallory" },
        gold,
      ),
    refusal("signature-mismatch", /unverified attestation/),
  );
  assert.throws(
    () =>
      completeCertificateSignature(certificate, signature, {
        ...gold,
        labels: gold.labels.map((label, index) =>
          index === 0 ? { ...label, axes: { ...label.axes, warmth: 1 } } : label,
        ),
      }),
    refusal("signature-mismatch", /unverified attestation/),
  );

  const completed = completeCertificateSignature(certificate, signature, gold);
  const replayed = {
    ...completed,
    corpus: { ...completed.corpus, sha256: "e".repeat(64) },
  } as Certificate;
  assert.throws(
    () => verifyPanelSignature({ certificate: replayed, session, ratings }),
    refusal("signature-mismatch", /does not match/),
  );
});

test("the CLI reports an unsigned certificate as pending-human and exits 3", async () => {
  const { certificate } = await pendingSigningFixture();
  const path = join(mkdtempSync(join(tmpdir(), "panel-cli-")), "certificate.json");
  writeFileSync(path, serializeCertificate(certificate), "utf8");
  const code = await main(["--certificate", path]);
  assert.equal(code, 3);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).verdict, "pending-human");
});

test("the CLI signs a pending certificate and never exits 0 while H2 is unmeasured", async () => {
  const { certificate, session, ratings } = await pendingSigningFixture();
  const root = studioRoot(session, ratings);
  const path = join(mkdtempSync(join(tmpdir(), "panel-cli-sign-")), "certificate.json");
  writeFileSync(path, serializeCertificate(certificate), "utf8");

  const code = await main([
    "--panel",
    session.sessionId,
    "--reviewer",
    REVIEWER,
    "--certificate",
    path,
    "--studio-root",
    root,
    "--evidence-root",
    root,
  ]);
  assert.equal(code, 1, "H2 is unmeasured, so a signed certificate is not a pass");
  const signed = parseCertificate(readFileSync(path, "utf8"));
  assert.equal(signed.verdict, "not-demo-ready");
  assert.equal(signed.panel?.sessionId, session.sessionId);
  assert.equal(
    signed.properties.find((property) => property.propertyId === "H2")?.reason,
    "unmeasured",
  );
});

test("the CLI refuses a missing reviewer by name", async () => {
  const { certificate, session, ratings } = await pendingSigningFixture();
  const root = studioRoot(session, ratings);
  const path = join(mkdtempSync(join(tmpdir(), "panel-cli-refuse-")), "certificate.json");
  writeFileSync(path, serializeCertificate(certificate), "utf8");

  const code = await main([
    "--panel",
    session.sessionId,
    "--certificate",
    path,
    "--studio-root",
    root,
    "--evidence-root",
    root,
  ]);
  assert.equal(code, 2);
});
