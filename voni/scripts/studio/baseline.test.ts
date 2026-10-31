/**
 * Ticket 25: the human-baseline verifier, driven by temp-fixture takes only.
 *
 * No recording, consent or hash here is real. Each fixture is a WAV whose
 * declared byte rate makes one byte one second, so a four-to-six-minute call is
 * a small file while the duration arithmetic is the production path. A test that
 * invents participant data would defeat the point of the gate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../../src/lib/demo/verification/scenarios/digest";
import {
  BASELINE_MAX_DURATION_MS,
  BASELINE_MIN_DURATION_MS,
  BaselineError,
  verifyBaseline,
  wavDurationMs,
} from "./baseline";
import { openTakeStore, type TakeRecord, type TakeStore } from "./take-store";

const LABELS = { intent: "describe a problem", emotion: "neutral", accent: "Irish English" };
const CONSENTED_AT = "2026-11-02";
const PARTICIPANTS = ["participant-01", "participant-02", "participant-03"] as const;

/**
 * A tiny PCM WAV that *declares* the requested duration: 1 kHz, mono, 8-bit,
 * so the byte rate is 1000 and the data size is the duration in milliseconds.
 */
function wav(callDurationMs: number): Buffer {
  const data = Buffer.alloc(Math.round(callDurationMs));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(1000, 24);
  header.writeUInt32LE(1000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function consentRef(participantId: string): string {
  return `${participantId}/consent.md`;
}

async function fileConsent(root: string, participantId: string, body?: string): Promise<string> {
  const dir = join(root, "consent", participantId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "consent.md");
  await writeFile(
    path,
    body ?? `# Consent\n\n${participantId} gave written consent on ${CONSENTED_AT} for baseline comparison audio.\n`,
  );
  return path;
}

async function landCall(
  store: TakeStore,
  participantId: string,
  call: 1 | 2,
  durationMs: number,
  supersedes?: string,
): Promise<TakeRecord> {
  return store.land({
    mode: "upload",
    audio: wav(durationMs),
    labels: LABELS,
    upload: { filename: `${participantId}-call-${call}.wav` },
    baseline: { participantId, consentRef: consentRef(participantId), consentedAt: CONSENTED_AT, call },
    ...(supersedes === undefined ? {} : { supersedes }),
  });
}

/** Three participants, two in-band calls each, consent filed beside the takes. */
async function landCompleteBaseline(store: TakeStore, root: string): Promise<TakeRecord[]> {
  const takes: TakeRecord[] = [];
  for (const participantId of PARTICIPANTS) {
    await fileConsent(root, participantId);
    takes.push(await landCall(store, participantId, 1, BASELINE_MIN_DURATION_MS));
    takes.push(await landCall(store, participantId, 2, BASELINE_MAX_DURATION_MS));
  }
  return takes;
}

async function withBaseline(
  run: (context: { root: string; store: TakeStore }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "voni-baseline-"));
  try {
    const store = await openTakeStore({ root });
    await run({ root, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function refusal(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof BaselineError, `expected BaselineError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2);
    return true;
  };
}

test("the WAV durater reads the declared band, not a guess", () => {
  assert.equal(wavDurationMs(wav(300_000)), 300_000);
  assert.equal(wavDurationMs(Buffer.from("not a wav")), null);
});

test("a complete baseline pins once and later runs reproduce the hash list", async () => {
  await withBaseline(async ({ root, store }) => {
    await landCompleteBaseline(store, root);

    const pinned = await verifyBaseline({ root, certificationRoots: [], record: true });
    assert.equal(pinned.participants, 3);
    assert.equal(pinned.takes.length, 6);
    assert.deepEqual(
      pinned.takes.map((take) => `${take.participantId}:${take.call}`),
      ["participant-01:1", "participant-01:2", "participant-02:1", "participant-02:2", "participant-03:1", "participant-03:2"],
    );

    const manifest = JSON.parse(await readFile(join(root, "baseline-hashes.json"), "utf8")) as {
      use: string;
      takes: { audioSha256: string }[];
    };
    assert.equal(manifest.use, "blind-comparison-only");
    assert.deepEqual(manifest.takes.map((take) => take.audioSha256), pinned.takes.map((take) => take.audioSha256));

    const verified = await verifyBaseline({ root, certificationRoots: [] });
    assert.deepEqual(verified.takes, pinned.takes, "a later run reproduces the pinned list exactly");
    assert.equal(verified.pinned, false);
  });
});

test("a missing consent reference fails closed, and a mismatched one is named", async () => {
  await withBaseline(async ({ root, store }) => {
    await landCompleteBaseline(store, root);
    await rm(join(root, "consent", "participant-02", "consent.md"));
    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [], record: true }),
      refusal("missing-consent-reference", /participant-02\/consent\.md/),
    );

    await fileConsent(root, "participant-02", "# Consent\n\nNo pseudonym and no date here.\n");
    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [], record: true }),
      refusal("consent-mismatch", /participant-02/),
    );
    assert.equal(
      (await readFile(join(root, "consent", "participant-02", "consent.md"), "utf8")).includes("participant-02"),
      false,
    );
  });
});

test("fewer than three participants and a missing second call are named refusals", async () => {
  await withBaseline(async ({ root, store }) => {
    for (const participantId of ["participant-01", "participant-02"] as const) {
      await fileConsent(root, participantId);
      await landCall(store, participantId, 1, 300_000);
      await landCall(store, participantId, 2, 300_000);
    }
    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [], record: true }),
      refusal("participant-count", /2 participants.*3–5/),
    );

    await fileConsent(root, "participant-03");
    await landCall(store, "participant-03", 1, 300_000);
    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [], record: true }),
      refusal("missing-baseline-call", /participant-03 is missing call 2/),
    );
  });
});

test("a call outside four to six minutes is refused by its measured duration", async () => {
  await withBaseline(async ({ root, store }) => {
    await landCompleteBaseline(store, root);
    const original = (await store.baselineTakes()).find(
      (take) => take.baseline!.participantId === "participant-01" && take.baseline!.call === 1,
    )!;
    await landCall(store, "participant-01", 1, BASELINE_MIN_DURATION_MS - 1000);
    await store.retire(original.takeId, { reviewer: "owner", reason: "fixture: replace the first call" });

    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [], record: true }),
      refusal("wrong-duration-band", /3\.98 min.*4\.00 min–6\.00 min/),
    );
  });
});

test("two active takes for one call are refused rather than silently picked", async () => {
  await withBaseline(async ({ root, store }) => {
    await landCompleteBaseline(store, root);
    await landCall(store, "participant-01", 1, 300_000);
    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [], record: true }),
      refusal("duplicate-baseline-call", /participant-01 has more than one active call 1/),
    );
  });
});

test("an edited blob is an edited take, never a quiet re-baseline", async () => {
  await withBaseline(async ({ root, store }) => {
    const takes = await landCompleteBaseline(store, root);
    await verifyBaseline({ root, certificationRoots: [], record: true });

    const first = takes[0]!;
    await writeFile(join(root, first.audioPath), wav(301_000));
    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [] }),
      refusal("edited-take", /changed on disk/),
    );
  });
});

test("a rehashed record is caught by the pinned hash list", async () => {
  await withBaseline(async ({ root, store }) => {
    const takes = await landCompleteBaseline(store, root);
    await verifyBaseline({ root, certificationRoots: [], record: true });

    const first = takes[0]!;
    const replacement = wav(299_000);
    const digest = sha256Hex(replacement);
    const recordPath = join(root, "takes", first.takeId, "take.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    await writeFile(join(root, "blobs", `${digest}.wav`), replacement);
    await writeFile(
      recordPath,
      `${JSON.stringify(
        { ...record, audioSha256: digest, audioBytes: replacement.byteLength, audioPath: `blobs/${digest}.wav` },
        null,
        2,
      )}\n`,
    );

    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [] }),
      refusal("edited-take", /changed after pinning/),
    );
  });
});

test("a baseline take id in a certification artifact is refused", async () => {
  await withBaseline(async ({ root, store }) => {
    const takes = await landCompleteBaseline(store, root);
    const artifacts = join(root, "certificates");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "cert-01.json"), `${JSON.stringify({ calls: [{ takeId: takes[0]!.takeId }] })}\n`);

    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [artifacts], record: true }),
      refusal("baseline-as-certification-input", /appears in certification artifact/),
    );
  });
});

test("pinning refuses to overwrite an existing hash list", async () => {
  await withBaseline(async ({ root, store }) => {
    await landCompleteBaseline(store, root);
    await verifyBaseline({ root, certificationRoots: [], record: true });
    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [], record: true }),
      refusal("manifest-exists", /already pinned/),
    );
  });
});

test("an unpinned baseline cannot pass verification and an empty store is not captured", async () => {
  await withBaseline(async ({ root, store }) => {
    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [] }),
      refusal("missing-take", /no active baseline take/),
    );

    await landCompleteBaseline(store, root);
    await assert.rejects(
      verifyBaseline({ root, certificationRoots: [] }),
      refusal("missing-manifest", /--record/),
    );
  });
});

test("a take whose duration cannot be measured is a refusal, not a zero", async () => {
  await withBaseline(async ({ root, store }) => {
    await landCompleteBaseline(store, root);
    await assert.rejects(
      verifyBaseline({
        root,
        certificationRoots: [],
        record: true,
        measureDuration: () => Number.NaN,
      }),
      refusal("duration-unmeasurable", /no measurable duration/),
    );
  });
});
