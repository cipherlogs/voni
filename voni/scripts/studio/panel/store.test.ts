/**
 * The panel sample lands in the same local Studio store the Rate surface reads:
 * creating a session with `panel: true` writes the twelve-call queue and the
 * blind projection, and reading it back preserves the sample.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../../../src/lib/demo/verification/scenarios/digest";
import { PANEL_SAMPLE_SIZE } from "../../../src/lib/demo/verification/panel/types";
import { openRatingStore } from "../rating-store";
import { call, sessionCertificate } from "./fixtures";

function wav(samples: number): Buffer {
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

test("the store writes a twelve-call panel session that reads back blind", async () => {
  const evidence = await mkdtemp(join(tmpdir(), "panel-store-"));
  const certificate = sessionCertificate({ callsPerLocale: 3 });
  const calls = [];
  for (const row of certificate.coverage.rows) {
    for (const callId of row.calls) {
      const audio = wav(8);
      const baseline = wav(24);
      await mkdir(join(evidence, "calls"), { recursive: true });
      await mkdir(join(evidence, "baseline"), { recursive: true });
      await writeFile(join(evidence, "calls", `${callId}.wav`), audio);
      await writeFile(join(evidence, "baseline", `${callId}.wav`), baseline);
      calls.push({
        ...call(callId, row.scenario, row.locale),
        audio: { path: `calls/${callId}.wav`, sha256: sha256Hex(audio) },
        baseline: { path: `baseline/${callId}.wav`, sha256: sha256Hex(baseline) },
      });
    }
  }

  const store = await openRatingStore({ root: join(evidence, "rating"), evidenceRoot: evidence });
  const created = await store.create({
    certificate,
    calls,
    reviewer: "owner",
    seed: 13,
    panel: true,
    createdAt: "2026-10-31T10:00:00.000Z",
  });
  assert.equal(created.session.queue.length, PANEL_SAMPLE_SIZE);
  assert.equal(created.blind.queue.length, PANEL_SAMPLE_SIZE);
  assert.equal(created.session.reviewer, "owner");

  const reopened = await store.get(created.session.sessionId);
  assert.deepEqual(reopened, created.session);
  assert.deepEqual(await store.blind(created.session.sessionId), created.blind);
});
