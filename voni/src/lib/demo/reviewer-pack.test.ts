import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { VOICES } from "@/lib/agents/voices";
import { AUDITION_MANIFEST_PATH, auditionClipFor, type AuditionClipRecord, type AuditionManifest } from "./audition-clips";
import {
  BALLOT_AXES,
  BALLOT_AXIS_LABELS,
  REVIEWER_PACK_DIR,
  REVIEWER_PACK_INDEX_PATH,
  carryVerdict,
  fileVerdict,
  formatReviewerPack,
  humanRatingsFromPack,
  packMissing,
  packStatus,
  recordingBytesProblem,
  recordingProblems,
  reviewerPackFor,
  reviewerPackProblems,
  type ReviewerPack,
  type ReviewerVerdict,
} from "./reviewer-pack";
import { resolveSubject } from "./subject";

/**
 * W5 parity proof (voice-parity ticket 58): the reviewer pack and verdict
 * record. Every ticket checkbox is an acceptance test here.
 *
 * The evidence is the committed pack set the checked-in script wrote; the
 * module is pure, so the test drives it with the same clip records the script
 * reads and no reviewer, call or credential.
 */

const root = new URL("../../../", import.meta.url);
const packFile = (voice: string) => new URL(`${REVIEWER_PACK_DIR}/${voice}.json`, root);
const packMarkdown = (voice: string) => new URL(`${REVIEWER_PACK_DIR}/${voice}.md`, root);

const manifest = (): AuditionManifest =>
  JSON.parse(readFileSync(new URL(AUDITION_MANIFEST_PATH, root), "utf8")) as AuditionManifest;

const readPack = (voice: string): ReviewerPack =>
  JSON.parse(readFileSync(packFile(voice), "utf8")) as ReviewerPack;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const assetBytes = (asset: string) => new Uint8Array(readFileSync(new URL(asset, root)));

/** A clip record shaped exactly like the evidence, for voices the manifest may not carry. */
function clipFixture(voiceId: string): AuditionClipRecord {
  const clip = auditionClipFor(voiceId);
  return {
    voice: clip.voiceId,
    locale: clip.locale,
    line: clip.text,
    lineSha256: clip.textSha256,
    asset: clip.asset,
    url: clip.url,
    volume: 100,
    facts: { sampleRate: 24_000, channels: 1, bitrateKbps: 160, frames: 10, durationMs: 5_000 },
    level: {
      sourceIntegratedLufs: -20,
      assetIntegratedLufs: -20,
      assetTruePeakDbtp: -1,
      assetCrestDb: 16,
      secondEncodeLufs: -20,
      secondEncodeTruePeakDbtp: -1,
      secondEncodeCrestDb: 16,
      referenceIntegratedLufs: null,
    },
    generatedOn: "2026-10-29",
  };
}

const RECORDING_SHA = "a".repeat(64);

function packFixture(voiceId: string, patch: Partial<ReviewerPack> = {}): ReviewerPack {
  return { ...reviewerPackFor(clipFixture(voiceId), RECORDING_SHA), ...patch };
}

function verdictFixture(patch: Partial<ReviewerVerdict> = {}): ReviewerVerdict {
  return {
    reviewer: "a named native reviewer",
    reviewedOn: "2026-10-29",
    locale: "es",
    scores: { timbre: 5, accent: 5, languageNaturalness: 5 },
    reasons: {},
    ...patch,
  };
}

// ── "Each Locale has one shared recording for rating." ───────────────────────

test("every offered voice has a pack bound to its own Locale's one committed recording", () => {
  const clips = manifest().clips;
  assert.equal(clips.length, VOICES.length, "the evidence must carry every offered voice");

  for (const voice of VOICES) {
    const pack = readPack(voice.id);
    assert.equal(pack.voice, voice.id);
    assert.equal(pack.locale, voice.languageCode, `${voice.id} must be judged in its own Locale`);

    const recording = pack.recording;
    assert.ok(recording, `${voice.id}: a pack without a recording cannot be handed out`);
    assert.equal(recording.source, "audition-clip");
    assert.equal(recording.asset, `public/voices/${voice.id}.mp3`);
    assert.equal(recording.url, `/voices/${voice.id}.mp3`);
    // The pack's provenance is the evidence record's, not a claim made up here.
    const clip = clips.find((candidate) => candidate.voice === voice.id);
    assert.ok(clip, `${voice.id}: the evidence has its clip row`);
    assert.equal(
      recording.nativeSource,
      clip.source ?? "agent-session",
      `${voice.id}: the pack names where the native audio actually came from`,
    );
    // The hash is the shared cut: one recording, identified by its bytes.
    assert.equal(recording.sha256, sha256(assetBytes(recording.asset)));
  }
});

test("one shared recording per voice and Locale, and no pack for a voice that has none", () => {
  const clips = manifest().clips;
  const packHashes = clips.map((clip) => {
    const pack = readPack(clip.voice);
    assert.equal(pack.recording?.asset, clip.asset);
    assert.equal(pack.recording?.sha256, sha256(assetBytes(clip.asset)));
    return `${clip.voice}:${pack.recording?.sha256}`;
  });
  assert.equal(new Set(packHashes).size, clips.length, "each voice judges its own committed clip");

  const index = JSON.parse(readFileSync(new URL(REVIEWER_PACK_INDEX_PATH, root), "utf8")) as {
    packs: Array<{ voice: string; recordingSha256: string; status: string }>;
  };
  assert.equal(index.packs.length, VOICES.length);
  for (const entry of index.packs) {
    assert.equal(entry.recordingSha256, readPack(entry.voice).recording?.sha256);
  }
});

// ── "The ballot carries timbre and accent." (+ ticket 75's third axis) ───────

test("the ballot carries timbre, accent and language naturalness", () => {
  assert.deepEqual([...BALLOT_AXES], ["timbre", "accent", "languageNaturalness"]);

  for (const voice of VOICES) {
    const pack = readPack(voice.id);
    assert.deepEqual(pack.ballot.axes, [...BALLOT_AXES]);
    assert.equal(pack.ballot.scale.min, 1);
    assert.equal(pack.ballot.scale.max, 5);
    assert.equal(pack.ballot.scale.pass, 5);
    assert.equal(pack.ballot.reasonRequiredBelow, 5);
  }
});

test("a filed ballot missing the language-naturalness axis is refused by name", () => {
  const pack = packFixture("lola");
  const verdict = verdictFixture();
  delete verdict.scores.languageNaturalness;

  assert.throws(
    () => fileVerdict(pack, verdict),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /languageNaturalness/);
      assert.match(error.message, /score/);
      return true;
    },
  );
});

// ── "Written reasons are stored with the score." ─────────────────────────────

test("a score below five without a written reason fails by axis name", () => {
  const pack = packFixture("lola");
  const verdict = verdictFixture({
    locale: "es",
    scores: { timbre: 4, accent: 5, languageNaturalness: 5 },
  });

  assert.throws(
    () => fileVerdict(pack, verdict),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /reason for timbre is missing/);
      return true;
    },
  );

  const filed = fileVerdict(pack, {
    ...verdict,
    reasons: { timbre: "the second sentence thins out and loses body" },
  });
  assert.equal(packStatus(filed), "complete");
  assert.deepEqual(filed.verdict?.scores, { timbre: 4, accent: 5, languageNaturalness: 5 });
  assert.equal(filed.verdict?.reasons.timbre, "the second sentence thins out and loses body");
});

test("a reason is required for every axis below five, not only the first", () => {
  const pack = packFixture("lola");
  assert.throws(
    () =>
      fileVerdict(pack, {
        reviewer: "a named native reviewer",
        reviewedOn: "2026-10-29",
        locale: "es",
        scores: { timbre: 5, accent: 3, languageNaturalness: 4 },
        reasons: { accent: "the stress is American on the question, not Spanish" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /reason for languageNaturalness is missing/);
      return true;
    },
  );
});

// ── "The named reviewer and date are required fields." ───────────────────────

test("a pack with no reviewer and no date is visibly pending, never passing", () => {
  for (const voice of VOICES) {
    const pack = readPack(voice.id);
    assert.equal(pack.verdict, null, `${voice.id}: no reviewer exists yet, so no verdict is invented`);
    assert.equal(packStatus(pack), "pending");
    assert.deepEqual(packMissing(pack), ["reviewer", "reviewedOn"]);
    assert.equal(pack.verdict, null);
  }
});

test("missing reviewer and missing date are refused by name", () => {
  const pack = packFixture("lola");
  assert.throws(
    () => fileVerdict(pack, verdictFixture({ reviewer: "  " })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /reviewer is missing/);
      return true;
    },
  );
  assert.throws(
    () => fileVerdict(pack, verdictFixture({ reviewedOn: "" })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /reviewedOn is missing/);
      return true;
    },
  );
  assert.throws(
    () => fileVerdict(pack, verdictFixture({ reviewedOn: "29/10/2026" })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /YYYY-MM-DD/);
      return true;
    },
  );
});

// ── Validation: missing recording and mismatched Locale fail by name ─────────

test("a pack with no recording fails by name and is never pending-passes", () => {
  const pack = packFixture("lola", { recording: null });
  assert.equal(packStatus(pack), "incomplete");
  const problems = reviewerPackProblems(pack);
  assert.ok(problems.some((problem) => problem.field === "recording"));
  assert.match(problems[0]?.message ?? "", /recording is missing/);
  assert.throws(
    () => fileVerdict(pack, verdictFixture()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /recording is missing/);
      return true;
    },
  );
});

test("a recording whose bytes do not match its hash is refused by name", () => {
  const pack = readPack("lola");
  const actual = sha256(assetBytes("public/voices/estelle.mp3"));
  const problem = recordingBytesProblem(pack, actual);
  assert.equal(problem?.field, "recording-sha256");
  assert.match(problem?.message ?? "", /does not match the committed bytes/);

  assert.equal(recordingBytesProblem(pack, pack.recording!.sha256), null);
});

test("a pack whose Locale disagrees with its recording fails by name", () => {
  const pack = packFixture("lola");
  const mismatched: ReviewerPack = {
    ...pack,
    locale: "it",
    recording: pack.recording ? { ...pack.recording, locale: "es" } : null,
  };
  const problems = reviewerPackProblems(mismatched);
  const locale = problems.find((problem) => problem.field === "locale");
  assert.ok(locale, "a silent Locale mismatch would judge the wrong language");
  assert.match(locale.message, /lola speaks es, not it|Locale/);

  assert.throws(
    () => {
      const wrongVoiceClip = { ...clipFixture("lola"), locale: "it" };
      return reviewerPackFor(wrongVoiceClip, RECORDING_SHA);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /speaks es, not it/);
      return true;
    },
  );
});

test("a verdict that names a different Locale than the recording is refused", () => {
  const pack = packFixture("lola");
  assert.throws(
    () => fileVerdict(pack, verdictFixture({ locale: "it" })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /locale/);
      return true;
    },
  );
});

// ── "The pack can be handed to a reviewer without further assembly." ─────────

test("every pack has a self-contained hand-off sheet with a ballot and a signature block", () => {
  for (const voice of VOICES) {
    assert.ok(existsSync(packMarkdown(voice.id)), `${voice.id}: no hand-off sheet`);
    const sheet = readFileSync(packMarkdown(voice.id), "utf8");
    assert.match(sheet, new RegExp(`# Parity proof — reviewer pack: ${voice.id} \\(${voice.languageCode}\\)`));
    for (const axis of BALLOT_AXES) {
      assert.match(sheet, new RegExp(`\\| ${BALLOT_AXIS_LABELS[axis]} \\|`), `${voice.id}: no ${axis} row`);
    }
    assert.match(sheet, /Reviewer \(named native reviewer\):\s*$/m);
    assert.match(sheet, /^Date:\s*$/m);
    const pack = readPack(voice.id);
    assert.match(sheet, new RegExp(pack.recording!.sha256));
    assert.match(sheet, /pending/);
    assert.match(sheet, /reason/i);
  }
});

test("a cascade-clip recording names the managed-path gap on the hand-off sheet", () => {
  const pack = reviewerPackFor({ ...clipFixture("jorg"), source: "cascade-clip" }, RECORDING_SHA);
  assert.equal(pack.recording?.nativeSource, "cascade-clip");

  const sheet = formatReviewerPack(pack);
  assert.match(
    sheet,
    /Provenance: audition-clip \(`cascade-clip`\), encoded from the committed cascade clip/,
    "the reviewer is told the clip came from the cascade path",
  );
  assert.match(
    sheet,
    /managed Voice Agent API did not serve/,
    "the managed-path gap is visible to the reviewer, not hidden as a generic clip",
  );
  assert.equal(pack.verdict, null, "naming the provenance is not recording an audition verdict");
});

test("the committed German pack names its cascade provenance and managed gap", () => {
  const pack = readPack("jorg");
  assert.equal(pack.recording?.nativeSource, "cascade-clip");
  const sheet = readFileSync(packMarkdown("jorg"), "utf8");
  assert.match(sheet, /cascade-clip/);
  assert.match(sheet, /managed Voice Agent API did not serve/);
  assert.equal(pack.verdict, null, "the pack stays pending: no audition verdict is recorded");
});

test("an unknown native source is refused by name", () => {
  const pack = packFixture("jorg");
  const broken: ReviewerPack = {
    ...pack,
    recording: pack.recording
      ? { ...pack.recording, nativeSource: "hand-capture" as never }
      : null,
  };
  const problems = recordingProblems(broken);
  const source = problems.find((problem) => problem.field === "recording-source");
  assert.ok(source, "an invented provenance is not silently accepted");
  assert.match(source.message, /hand-capture/);
  assert.match(source.message, /agent-session|audition-clip/);
});

test("a complete pack's sheet records the reviewer, the date and the reasons", () => {
  const pack = fileVerdict(packFixture("lola"), {
    reviewer: "a named native reviewer",
    reviewedOn: "2026-10-29",
    locale: "es",
    scores: { timbre: 5, accent: 4, languageNaturalness: 5 },
    reasons: { accent: "the /r/ is tapped where a Spanish speaker would trill it" },
  });
  const sheet = formatReviewerPack(pack);
  assert.match(sheet, /Status: \*\*complete\*\*/);
  assert.match(sheet, /a named native reviewer/);
  assert.match(sheet, /2026-10-29/);
  assert.match(sheet, /the \/r\/ is tapped/);
});

// ── Ticket 75: a filed verdict becomes the weighted ballot's third axis ─────

test("a filed verdict loads into the weighted ballot with language naturalness", () => {
  const pack = fileVerdict(packFixture("lola"), {
    reviewer: "a named native reviewer",
    reviewedOn: "2026-10-29",
    locale: "es",
    scores: { timbre: 5, accent: 5, languageNaturalness: 4 },
    reasons: { languageNaturalness: "the greeting reads like a translation of the English" },
  });

  const human = humanRatingsFromPack(pack);
  assert.equal(human.ratings.length, 1, "one reviewer is one ballot");
  assert.equal(human.ratings[0]?.rater, "a named native reviewer");
  assert.equal(human.ratings[0]?.timbre, 5);
  assert.equal(human.ratings[0]?.accent, 5);
  assert.equal(human.ratings[0]?.languageNaturalness, 4, "the third axis crosses into the ballot");
  assert.equal(
    human.ratings[0]?.reasons?.languageNaturalness,
    "the greeting reads like a translation of the English",
    "the reviewer's reason is kept with the score",
  );
  assert.equal(human.recordingSha256, pack.recording?.sha256, "the ballot judges the pack's shared cut");
  assert.equal(human.ratings[0]?.recordingSha256, pack.recording?.sha256);
  assert.equal(human.subject?.locale, "es", "the ballot is per subject, derived from the pack's voice");
  assert.equal(human.languageNaturalness, 4);
  // 0.5×5 + 0.25×5 + 0.25×4 = 4.75, worked out independently of the module.
  assert.equal(human.weighted, 4.75);
});

test("a pending pack yields an empty ballot bound to its recording, never an invented score", () => {
  const human = humanRatingsFromPack(reviewerPackFor(clipFixture("lola"), RECORDING_SHA));
  assert.deepEqual(human.ratings, []);
  assert.equal(human.recordingSha256, RECORDING_SHA);
  assert.equal(human.subject?.locale, "es");
  assert.equal(human.weighted, null);
  assert.equal(human.languageNaturalness, null);
});

test("the adapter refuses a verdict that drops the third axis instead of loading it", () => {
  const pack = packFixture("lola");
  const verdict = verdictFixture();
  delete verdict.scores.languageNaturalness;
  // A pack read back from disk is not trusted: the adapter revalidates it.
  const withVerdict: ReviewerPack = { ...pack, verdict };

  assert.throws(
    () => humanRatingsFromPack(withVerdict),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /languageNaturalness/);
      return true;
    },
  );
});

test("a pack is one subject's ballot: it never loads against another Locale's subject", () => {
  const pack = fileVerdict(packFixture("lola"), verdictFixture());
  const anna = resolveSubject({ voice: "anna" });
  assert.throws(
    () => humanRatingsFromPack(pack, anna),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /locale|Spanish|es/);
      return true;
    },
  );
  // The subject it names loads unchanged.
  const lola = resolveSubject({ voice: "lola" });
  const human = humanRatingsFromPack(pack, lola);
  assert.equal(human.subject?.agent.kind, "demo");
  assert.equal(human.weighted, 5);
});

// ── Regeneration: a new recording invalidates the old verdict ────────────────

test("regenerating keeps a filed verdict while the recording is unchanged and drops it when the clip changes", () => {
  const filed = fileVerdict(packFixture("lola"), verdictFixture());
  const same = reviewerPackFor(clipFixture("lola"), RECORDING_SHA);
  assert.equal(carryVerdict(filed, same).verdict?.reviewer, "a named native reviewer");

  const newRecording = reviewerPackFor(clipFixture("lola"), "b".repeat(64));
  assert.equal(
    carryVerdict(filed, newRecording).verdict,
    null,
    "a verdict for audio nobody can hear any more is not a verdict for the new clip",
  );
});

// ── The index: all voices, statuses, nothing invented ────────────────────────

test("the pack index lists every voice with its status and no invented reviewer", () => {
  const index = JSON.parse(readFileSync(new URL(REVIEWER_PACK_INDEX_PATH, root), "utf8")) as {
    schemaVersion: number;
    command: string;
    counts: { total: number; pending: number; complete: number; incomplete: number };
    packs: Array<{ voice: string; locale: string; status: string; reviewer: string | null; reviewedOn: string | null }>;
  };
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.command, "cd voni && npm run voice:packs");
  assert.equal(index.counts.total, VOICES.length);
  assert.equal(index.counts.pending + index.counts.complete + index.counts.incomplete, index.counts.total);
  assert.equal(index.counts.pending, index.packs.filter((entry) => entry.status === "pending").length);

  for (const entry of index.packs) {
    assert.equal(entry.status, packStatus(readPack(entry.voice)));
    assert.equal(entry.reviewer, null, "reviewer names are owner input and are never invented");
    assert.equal(entry.reviewedOn, null);
  }
});
