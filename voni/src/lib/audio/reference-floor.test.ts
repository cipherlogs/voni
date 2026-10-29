/**
 * Ticket 126: the committed vendor floor is the reference baseline, and only
 * for the voice it was captured in.
 *
 * Three properties make the floor evidence rather than a convenience:
 *
 * - **It is read, not recomputed.** The baseline is `anna`'s committed capture
 *   in `evidence/vendor-floor/`, resolved by the one loader; the artifact records
 *   that file's path and sha256, never a freshly synthesised substitute.
 * - **Only the featured voice has one.** Every other voice is compared to its
 *   own reference rendering; comparing `lola`'s level to `anna`'s floor would
 *   judge one voice against another voice's audio.
 * - **A reference worse than the floor is a vendor-voice regression.** The
 *   reference is the vendor's own render; if it has slipped below the floor, no
 *   downstream layer can be judged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VENDOR_FLOOR_DIR,
  VENDOR_FLOOR_VOICE,
  VendorFloorError,
  assertVendorFloorEvidenceIsCommitted,
  loadVendorFloor,
  vendorFloorEvidence,
  type VendorFloorEvidence,
} from "./vendor-floor";
import { judgeReferenceAgainstFloor, referenceBaseline } from "./reference-floor";
import { compareReferenceAndDelivered, type TwoCaptureComparison } from "./comparison";
import { decideW0Verdict } from "./w0-verdict";
import { VONI_GREETINGS } from "../demo/voni-agent";
import { decodePcm } from "./format-facts";

/** The sidecar's committed hash, read independently of the loader under test. */
function committedSha256(voice = "anna", locale = "en"): string {
  const sidecar = JSON.parse(
    readFileSync(join(VENDOR_FLOOR_DIR, `${voice}-${locale}.json`), "utf8"),
  ) as { audio: { sha256: string } };
  return sidecar.audio.sha256;
}

/** A short tone, enough for the level/peak/breakup axes the check reads. */
function tone(amplitude = 0.1, frames = 24_000): Int16Array {
  const samples = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    samples[frame] = Math.round(
      amplitude * 32_767 * Math.sin((2 * Math.PI * 220 * frame) / 24_000),
    );
  }
  return samples;
}

function decoded(samples: Int16Array, rate = 24_000) {
  return decodePcm(new Uint8Array(samples.buffer.slice(0)), { sampleRate: rate, channels: 1 });
}

test("the featured voice's baseline is its committed floor, read from the evidence", () => {
  const baseline = referenceBaseline(VENDOR_FLOOR_VOICE, "en");

  assert.equal(baseline.kind, "committed-floor");
  if (baseline.kind !== "committed-floor") return;
  assert.equal(baseline.voice, "anna");
  assert.equal(baseline.locale, "en");
  assert.equal(baseline.floor.path, join(VENDOR_FLOOR_DIR, "anna-en.wav"));
  assert.equal(baseline.floor.provenance.audio.sha256, committedSha256());
  // The floor is the committed capture, not a re-rendered file: the bytes on
  // disk are the bytes the sidecar hashes.
  assert.equal(loadVendorFloor().path, baseline.floor.path);
});

test("every other voice is compared to its own reference, never another voice's floor", () => {
  const baseline = referenceBaseline("lola", "es");

  assert.equal(baseline.kind, "own-reference");
  if (baseline.kind !== "own-reference") return;
  assert.equal(baseline.voice, "lola");
  assert.equal(baseline.locale, "es");
  assert.match(baseline.reason, /no committed floor/);
  assert.match(baseline.reason, /its own reference/);
  assert.match(baseline.reason, /another voice/);
});

test("the artifact's floor record is the committed file's path and hash, never audio", () => {
  const evidence = vendorFloorEvidence(loadVendorFloor());

  assert.deepEqual(evidence, {
    path: join(VENDOR_FLOOR_DIR, "anna-en.wav"),
    sha256: committedSha256(),
    voice: "anna",
    locale: "en",
    capturedOn: "2026-10-29",
    method: "vendor-tts-http",
  });
  assert.equal(JSON.stringify(evidence).includes("RIFF"), false);
});

test("a recorded floor that is not the committed one is refused by name", () => {
  const committed = vendorFloorEvidence(loadVendorFloor());

  assert.doesNotThrow(() => assertVendorFloorEvidenceIsCommitted(committed, committed));

  const recomputed: VendorFloorEvidence = {
    ...committed,
    path: "/tmp/regenerated/anna-en.wav",
    sha256: "b".repeat(64),
  };
  assert.throws(
    () => assertVendorFloorEvidenceIsCommitted(recomputed, committed),
    (error: unknown) =>
      error instanceof VendorFloorError &&
      error.code === "vendor-floor-evidence-mismatch" &&
      /not the committed floor/.test(error.message) &&
      /read from the committed evidence/.test(error.message),
  );
});

test("a reference worse than the committed floor names a vendor-voice regression", () => {
  const baseline = referenceBaseline(VENDOR_FLOOR_VOICE, "en");
  assert.equal(baseline.kind, "committed-floor");
  if (baseline.kind !== "committed-floor") return;

  // A quiet, thin render of the same voice: a self-consistent file that is
  // nonetheless below the floor the owner called superb.
  const reference = { path: "captures/reference-anna-en.wav", audio: decoded(tone(0.008)) };
  const finding = judgeReferenceAgainstFloor({ reference, floor: baseline.floor });

  assert.equal(finding.status, "regression");
  assert.match(finding.sentence, /vendor-voice regression/);
  assert.match(finding.sentence, new RegExp(baseline.floor.provenance.audio.sha256));
  assert.ok(finding.axes.some((axis) => axis.axis === "level" && axis.standing === "worse"));
  assert.equal(finding.baseline, "committed-floor");
});

test("a reference within the committed floor is not a regression", () => {
  const floor = loadVendorFloor();
  const finding = judgeReferenceAgainstFloor({
    reference: { path: floor.path, audio: floor.audio },
    floor,
  });

  assert.equal(finding.status, "within-floor");
  assert.equal(finding.regression, false);
  assert.doesNotMatch(finding.sentence, /regression/);
});

test("a voice without a floor is not judged against another voice's audio", () => {  const baseline = referenceBaseline("lola", "es");
  assert.equal(baseline.kind, "own-reference");
  if (baseline.kind !== "own-reference") return;

  const finding = judgeReferenceAgainstFloor({
    reference: { path: "captures/reference-lola-es.wav", audio: decoded(tone()) },
    floor: null,
    voice: "lola",
    locale: "es",
    ownReference: baseline.reason,
  });

  assert.equal(finding.status, "no-floor");
  assert.equal(finding.regression, false);
  assert.match(finding.sentence, /own reference/);
  assert.match(finding.sentence, /lola\/es/);
  assert.deepEqual(finding.axes, []);
});

// ── The W0 verdict names the layer ──────────────────────────────────────────

/** A measured two-capture comparison: one line, two tone renders, aligned. */
function measuredComparison(): TwoCaptureComparison {
  const line = { text: VONI_GREETINGS.en };
  const audio = decoded(tone(0.1, 48_000));
  return compareReferenceAndDelivered({
    reference: { path: "captures/reference-anna-en.wav", audio },
    delivered: { path: "captures/delivered-anna-en.wav", audio },
    line: { kind: "greeting", text: line.text },
    spokenLine: line.text,
  });
}

test("the W0 verdict names the vendor voice when the reference is below the floor", () => {
  const baseline = referenceBaseline(VENDOR_FLOOR_VOICE, "en");
  assert.equal(baseline.kind, "committed-floor");
  if (baseline.kind !== "committed-floor") return;
  const referenceFloor = judgeReferenceAgainstFloor({
    reference: { path: "captures/reference-anna-en.wav", audio: decoded(tone(0.008)) },
    floor: baseline.floor,
  });

  const verdict = decideW0Verdict({
    comparison: measuredComparison(),
    transcript: VONI_GREETINGS.en,
    referenceFloor,
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "vendor voice");
  assert.equal(verdict.axis, "floor");
  assert.match(verdict.sentence, /vendor-voice regression/);
  const later = verdict.layers.filter((layer) => layer.layer !== "vendor voice");
  assert.ok(
    later.every((layer) => layer.status === "NOT-COMPARABLE"),
    "nothing downstream is judged while the vendor voice is below its floor",
  );
});

test("the W0 verdict does not borrow another voice's floor", () => {
  const baseline = referenceBaseline("lola", "es");
  assert.equal(baseline.kind, "own-reference");
  if (baseline.kind !== "own-reference") return;
  const referenceFloor = judgeReferenceAgainstFloor({
    reference: { path: "captures/reference-lola-es.wav", audio: decoded(tone()) },
    floor: null,
    voice: "lola",
    locale: "es",
    ownReference: baseline.reason,
  });

  const verdict = decideW0Verdict({
    comparison: measuredComparison(),
    transcript: VONI_GREETINGS.en,
    referenceFloor,
  });

  assert.notEqual(verdict.layer, "vendor voice");
  const floorCheck = verdict.checks.find((entry) => entry.metric === "floor");
  assert.equal(floorCheck?.status, "SKIPPED");
  assert.match(floorCheck?.reason ?? "", /own reference/);
});
