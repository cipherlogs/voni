/**
 * Ticket 23's take store: one hashed record per take, never edited in place.
 *
 * The tests drive the store's public interface the way the Record surface does:
 * land a take, ask for it back, rehash it. A test that reaches into the
 * directory layout would freeze the storage shape, which is not the contract —
 * the contract is "a take has one sha256, it never changes, and re-recording
 * adds a take beside it".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTakeStore, StudioError } from "./take-store";

/** A minimal, well-formed 16 kHz mono PCM WAV with `samples` zero bytes. */
function wav(samples = 8): Buffer {
  const data = Buffer.alloc(samples);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * A worked example, not a recomputation: `sha256sum` of the 52-byte fixture
 * above. A test that hashes the bytes again the way the store does would pass
 * for any hash function, including a wrong one.
 */
const WAV_8_SHA256 = "d7fa3ddfa728ccfff93b6a69ba7c00d9fe477014748235843964c84b5525ee9f";

const LABELS = {
  intent: "ask a question about booking",
  emotion: "neutral",
  accent: "Indian English",
};

async function withStore(run: (store: Awaited<ReturnType<typeof openTakeStore>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "voni-studio-"));
  try {
    await run(await openTakeStore({ root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertRefusal(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof StudioError, `expected StudioError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2, "a refusal is exit 2, never a stored take");
    return true;
  };
}

// ── One-shot line ───────────────────────────────────────────────────────────

test("a one-shot line lands as one take with its sha256, prompt card and labels", async () => {
  await withStore(async (store) => {
    const take = await store.land({
      mode: "one-shot",
      audio: wav(),
      labels: LABELS,
      prompt: { text: "Hi, is this Voni?" },
    });

    assert.equal(take.schemaVersion, 1);
    assert.equal(take.takeId, "take-000001");
    assert.equal(take.audioSha256, WAV_8_SHA256, "the digest is the pinned worked example");
    assert.equal(take.audioBytes, 52);
    assert.equal(take.audioFormat, "wav");
    assert.deepEqual(take.labels, LABELS);
    assert.deepEqual(take.source, {
      mode: "one-shot",
      prompt: { text: "Hi, is this Voni?" },
    });
    assert.equal(take.supersedes, undefined);

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], take, "a landed take reads back exactly as it landed");
  });
});

// ── Turn-by-turn dialogue ───────────────────────────────────────────────────

test("a turn-by-turn dialogue records each line against its own prompt card", async () => {
  await withStore(async (store) => {
    const cards = [
      { dialogue: "booking-basic", line: "open", turn: 1, text: "Hi, I'd like to book a table." },
      { dialogue: "booking-basic", line: "time", turn: 2, text: "Friday at seven, please." },
    ];
    const first = await store.land({ mode: "dialogue", audio: wav(8), labels: LABELS, prompt: cards[0] });
    const second = await store.land({ mode: "dialogue", audio: wav(16), labels: LABELS, prompt: cards[1] });

    assert.equal(first.takeId, "take-000001");
    assert.equal(second.takeId, "take-000002");
    assert.deepEqual(first.source, { mode: "dialogue", prompt: cards[0] });
    assert.deepEqual(second.source, { mode: "dialogue", prompt: cards[1] });

    const listed = await store.list();
    assert.deepEqual(
      listed.map((take) => [take.source.mode, (take.source as { prompt: { line: string } }).prompt.line, (take.source as { prompt: { turn: number } }).prompt.turn]),
      [
        ["dialogue", "time", 2],
        ["dialogue", "open", 1],
      ],
      "each landed take carries the line and turn it was recorded against",
    );
  });
});

test("a dialogue line without its card is refused, never recorded against a guessed prompt", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      store.land({
        mode: "dialogue",
        audio: wav(),
        labels: LABELS,
        prompt: { dialogue: "booking-basic", line: "open", text: "Hi" } as never,
      }),
      assertRefusal("invalid-prompt", /prompt card/),
    );
    await assert.rejects(
      store.land({
        mode: "dialogue",
        audio: wav(),
        labels: LABELS,
        prompt: { dialogue: "booking-basic", line: "open", turn: 0, text: "Hi" },
      }),
      assertRefusal("invalid-prompt", /prompt card/),
    );
    await assert.rejects(
      store.land({
        mode: "dialogue",
        audio: wav(),
        labels: LABELS,
        prompt: { dialogue: "booking-basic", line: "open", turn: 1, text: "   " },
      }),
      assertRefusal("missing-prompt", /prompt card/),
    );
  });
});

// ── Upload ──────────────────────────────────────────────────────────────────

test("an uploaded file lands as a take with its filename and sniffed format", async () => {
  await withStore(async (store) => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("studio-upload")]);
    const take = await store.land({
      mode: "upload",
      audio: webm,
      labels: LABELS,
      upload: { filename: "/home/someone/Downloads/caller-take.webm", contentType: "audio/webm" },
    });
    assert.equal(take.audioFormat, "webm");
    assert.equal(take.audioBytes, webm.byteLength);
    assert.deepEqual(take.source, {
      mode: "upload",
      upload: { filename: "caller-take.webm", contentType: "audio/webm" },
    });
    assert.equal((await store.read(take.takeId)).bytes.toString("hex"), webm.toString("hex"));
  });
});

test("an empty or unrecognised file is refused by name, never stored as a take", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      store.land({ mode: "upload", audio: Buffer.alloc(0), labels: LABELS, upload: { filename: "empty.wav" } }),
      assertRefusal("empty-take", /empty/),
    );
    await assert.rejects(
      store.land({ mode: "upload", audio: Buffer.from("not audio"), labels: LABELS, upload: { filename: "notes.txt" } }),
      assertRefusal("unsupported-audio", /WAV, WebM, Ogg, MP3 or M4A/),
    );
  });
});

// ── Labels ──────────────────────────────────────────────────────────────────

test("intent, emotion and accent labels are stored with the take", async () => {
  await withStore(async (store) => {
    const take = await store.land({
      mode: "one-shot",
      audio: wav(),
      labels: { intent: "  book a table  ", emotion: "enthusiastic", accent: "Nigerian English" },
      prompt: { text: "Table for two." },
    });
    assert.deepEqual(take.labels, {
      intent: "book a table",
      emotion: "enthusiastic",
      accent: "Nigerian English",
    });
    assert.deepEqual((await store.get(take.takeId))!.labels, take.labels);
  });
});

test("a missing, empty or unknown label is refused by name, never defaulted or invented", async () => {
  await withStore(async (store) => {
    const missing = { emotion: "neutral", accent: "Irish English" } as never;
    await assert.rejects(
      store.land({ mode: "one-shot", audio: wav(), labels: missing, prompt: { text: "Hi" } }),
      assertRefusal("missing-label", /intent/),
    );
    await assert.rejects(
      store.land({ mode: "one-shot", audio: wav(), labels: { ...LABELS, emotion: " " }, prompt: { text: "Hi" } }),
      assertRefusal("invalid-label", /emotion/),
    );
    await assert.rejects(
      store.land({ mode: "one-shot", audio: wav(), labels: { ...LABELS, mood: "happy" } as never, prompt: { text: "Hi" } }),
      assertRefusal("unknown-label", /mood/),
    );
    assert.equal((await store.list()).length, 0, "a refused take leaves nothing behind");
  });
});

test("two takes with the same bytes keep distinct ids and the same content address", async () => {
  await withStore(async (store) => {
    const first = await store.land({ mode: "one-shot", audio: wav(), labels: LABELS, prompt: { text: "Hi" } });
    const second = await store.land({ mode: "one-shot", audio: wav(), labels: LABELS, prompt: { text: "Hi" } });
    assert.notEqual(first.takeId, second.takeId);
    assert.equal(first.audioSha256, second.audioSha256);
    assert.equal(first.audioPath, second.audioPath);
    assert.equal((await store.verify()).takes, 2);
  });
});

// ── Re-record and immutability ──────────────────────────────────────────────

test("a re-record creates a new take and the earlier hash stays resolvable", async () => {
  await withStore(async (store) => {
    const first = await store.land({ mode: "one-shot", audio: wav(8), labels: LABELS, prompt: { text: "Hi" } });
    const second = await store.land({
      mode: "one-shot",
      audio: wav(16),
      labels: { ...LABELS, emotion: "calmer" },
      prompt: { text: "Hi" },
      supersedes: first.takeId,
    });

    assert.equal(second.takeId, "take-000002");
    assert.equal(second.supersedes, first.takeId);
    assert.notEqual(second.audioSha256, first.audioSha256);

    const original = await store.get(first.takeId);
    assert.deepEqual(original, first, "the superseded take is not rewritten");
    const { bytes } = await store.read(first.takeId);
    assert.equal(bytes.byteLength, 52, "the earlier bytes remain readable by its hash");
    assert.equal((await store.verify()).takes, 2);
  });
});

test("re-recording the superseded take again is refused, keeping the lineage one line", async () => {
  await withStore(async (store) => {
    const first = await store.land({ mode: "one-shot", audio: wav(8), labels: LABELS, prompt: { text: "Hi" } });
    await store.land({ mode: "one-shot", audio: wav(16), labels: LABELS, prompt: { text: "Hi" }, supersedes: first.takeId });
    await assert.rejects(
      store.land({ mode: "one-shot", audio: wav(24), labels: LABELS, prompt: { text: "Hi" }, supersedes: first.takeId }),
      assertRefusal("already-superseded", /already re-recorded/),
    );
    await assert.rejects(
      store.land({ mode: "one-shot", audio: wav(), labels: LABELS, prompt: { text: "Hi" }, supersedes: "take-000099" }),
      assertRefusal("unknown-take", /take-000099/),
    );
  });
});

test("a changed audio file is refused when read, never served under the old hash", async () => {
  await withStore(async (store) => {
    const take = await store.land({ mode: "one-shot", audio: wav(8), labels: LABELS, prompt: { text: "Hi" } });
    const blobPath = join(store.root, take.audioPath);
    await writeFile(blobPath, wav(24));

    await assert.rejects(store.read(take.takeId), assertRefusal("take-drift", new RegExp(take.audioSha256)));
    await assert.rejects(store.verify(), assertRefusal("take-drift", /take-000001/));
  });
});

test("the store has no edit or delete surface: a take is appended, never mutated", async () => {
  await withStore(async (store) => {
    const first = await store.land({ mode: "one-shot", audio: wav(8), labels: LABELS, prompt: { text: "Hi" } });
    await store.land({ mode: "one-shot", audio: wav(16), labels: LABELS, prompt: { text: "Hi" }, supersedes: first.takeId });

    assert.deepEqual(
      Object.keys(store).sort(),
      ["assertSelectable", "baselineTakes", "corpus", "get", "land", "list", "read", "retire", "retirement", "root", "selectable", "verify"],
      "re-recording is the only change a take has: no update, patch, rename or delete",
    );
    assert.deepEqual(await store.get(first.takeId), first);
  });
});

// ── Retirement ──────────────────────────────────────────────────────────────

test("retiring a take marks it and leaves the take, its record and its hash untouched", async () => {
  await withStore(async (store) => {
    const take = await store.land({ mode: "one-shot", audio: wav(8), labels: LABELS, prompt: { text: "Hi" } });
    const recordPath = join(store.root, "takes", take.takeId, "take.json");
    const before = await readFile(recordPath);
    const beforeAudio = await store.read(take.takeId);

    const retirement = await store.retire(take.takeId, {
      reviewer: "owner",
      reason: "the accent was wrong for this scenario",
    });

    assert.equal(retirement.takeId, take.takeId);
    assert.equal(retirement.audioSha256, take.audioSha256, "the retirement names the exact hashed bytes it retires");
    assert.equal(retirement.reviewer, "owner");
    assert.match(retirement.reason, /accent/);
    assert.match(retirement.retiredAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.deepEqual(await store.get(take.takeId), take, "the take record is not rewritten");
    assert.deepEqual(await readFile(recordPath), before, "the take.json bytes are unchanged");
    const afterAudio = await store.read(take.takeId);
    assert.equal(afterAudio.record.audioSha256, take.audioSha256);
    assert.deepEqual(afterAudio.bytes, beforeAudio.bytes, "a retired take remains readable by its hash");
    assert.deepEqual(await store.retirement(take.takeId), retirement);
  });
});

test("a retired take cannot be selected by a new scenario, while the rest stay selectable", async () => {
  await withStore(async (store) => {
    const retired = await store.land({ mode: "one-shot", audio: wav(8), labels: LABELS, prompt: { text: "Hi" } });
    const kept = await store.land({ mode: "one-shot", audio: wav(16), labels: LABELS, prompt: { text: "Bye" } });
    await store.retire(retired.takeId, { reviewer: "owner", reason: "retired from the reserve" });

    assert.deepEqual((await store.selectable()).map((take) => take.takeId), [kept.takeId]);
    await assert.rejects(
      store.assertSelectable(retired.takeId),
      assertRefusal("take-retired", /retired/),
    );
    assert.deepEqual(await store.assertSelectable(kept.takeId), kept);

    const corpus = await store.corpus();
    assert.equal(corpus.length, 2);
    assert.equal(corpus.find((entry) => entry.record.takeId === retired.takeId)?.selectable, false);
    assert.equal(corpus.find((entry) => entry.record.takeId === kept.takeId)?.selectable, true);
  });
});

test("retiring twice or retiring an unknown take is refused by name", async () => {
  await withStore(async (store) => {
    const take = await store.land({ mode: "one-shot", audio: wav(8), labels: LABELS, prompt: { text: "Hi" } });
    const other = await store.land({ mode: "one-shot", audio: wav(16), labels: LABELS, prompt: { text: "Bye" } });
    await store.retire(take.takeId, { reviewer: "owner", reason: "first" });
    await assert.rejects(
      store.retire(take.takeId, { reviewer: "owner", reason: "second" }),
      assertRefusal("already-retired", /already retired/),
    );
    await assert.rejects(
      store.retire("take-000099", { reviewer: "owner", reason: "nope" }),
      assertRefusal("unknown-take", /take-000099/),
    );
    await assert.rejects(
      store.retire(other.takeId, { reviewer: " ", reason: "nope" }),
      assertRefusal("missing-reviewer", /reviewer/),
    );
    await assert.rejects(
      store.retire(other.takeId, { reviewer: "owner", reason: " " }),
      assertRefusal("missing-reason", /reason/),
    );
  });
});

// ── Baseline consent ────────────────────────────────────────────────────────

const BASELINE = {
  participantId: "p-01",
  consentRef: "consent-2026-10-31-p01",
  consentedAt: "2026-10-31",
  call: 1 as const,
};

test("a baseline take records its participant, consent reference and consent date", async () => {
  await withStore(async (store) => {
    const take = await store.land({
      mode: "upload",
      audio: wav(8),
      labels: { ...LABELS, accent: "Indian English" },
      upload: { filename: "baseline-p01-call-1.wav" },
      baseline: BASELINE,
    });

    assert.deepEqual(take.baseline, BASELINE);
    assert.deepEqual((await store.get(take.takeId))!.baseline, BASELINE);
    const raw = JSON.parse(await readFile(join(store.root, "takes", take.takeId, "take.json"), "utf8")) as {
      baseline: unknown;
    };
    assert.deepEqual(raw.baseline, BASELINE, "consent metadata is written with the take, not supplied at read time");
  });
});

test("a baseline take is blind comparison audio, never a scenario take", async () => {
  await withStore(async (store) => {
    const baseline = await store.land({
      mode: "one-shot",
      audio: wav(8),
      labels: LABELS,
      prompt: { text: "I would like to book a table." },
      baseline: BASELINE,
    });
    const scenario = await store.land({ mode: "one-shot", audio: wav(16), labels: LABELS, prompt: { text: "Hi" } });

    assert.deepEqual((await store.selectable()).map((take) => take.takeId), [scenario.takeId]);
    await assert.rejects(
      store.assertSelectable(baseline.takeId),
      assertRefusal("baseline-take", /blind comparison/),
    );
  });
});

test("baselineTakes lists only active baseline takes, never scenario takes", async () => {
  await withStore(async (store) => {
    const baseline = await store.land({
      mode: "one-shot",
      audio: wav(8),
      labels: LABELS,
      prompt: { text: "I would like to book a table." },
      baseline: BASELINE,
    });
    await store.land({ mode: "one-shot", audio: wav(16), labels: LABELS, prompt: { text: "Hi" } });

    assert.deepEqual((await store.baselineTakes()).map((take) => take.takeId), [baseline.takeId]);
    await store.retire(baseline.takeId, { reviewer: "owner", reason: "fixture: superseded call" });
    assert.deepEqual(await store.baselineTakes(), [], "a retired baseline take is not part of the pinned list");
  });
});

test("a baseline take without complete consent metadata is refused by name, never stored", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      store.land({
        mode: "one-shot",
        audio: wav(),
        labels: LABELS,
        prompt: { text: "Hi" },
        baseline: { ...BASELINE, consentRef: " " },
      }),
      assertRefusal("missing-baseline-consent", /consentRef/),
    );
    await assert.rejects(
      store.land({
        mode: "one-shot",
        audio: wav(),
        labels: LABELS,
        prompt: { text: "Hi" },
        baseline: { ...BASELINE, consentedAt: "31/10/2026" },
      }),
      assertRefusal("invalid-baseline-consent", /consentedAt/),
    );
    await assert.rejects(
      store.land({
        mode: "one-shot",
        audio: wav(),
        labels: LABELS,
        prompt: { text: "Hi" },
        baseline: { ...BASELINE, call: 3 as 1 },
      }),
      assertRefusal("invalid-baseline-consent", /call/),
    );
    await assert.rejects(
      store.land({
        mode: "one-shot",
        audio: wav(),
        labels: LABELS,
        prompt: { text: "Hi" },
        baseline: { ...BASELINE, consentEmail: "someone@example.com" } as never,
      }),
      assertRefusal("unknown-baseline-consent-field", /consentEmail/),
    );
    assert.equal((await store.list()).length, 0, "a refused baseline leaves nothing behind");
  });
});
