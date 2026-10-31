/**
 * Ticket 25's zero-typing baseline flow (branch `ticket/dv25b-flow`).
 *
 * The owner presses record, speaks and presses stop. Everything else — the
 * participant pseudonym, the accent selector values, the call labels and the
 * consent pointer — is fixed by this plan, so the test asserts the plan itself
 * against the documented values rather than re-deriving them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { BaselineError, audioDurationMs } from "./baseline";
import { startStudio, type RunningStudio } from "./http";

import {
  BASELINE_CALL_LABELS,
  BASELINE_ACCENTS,
  DEFAULT_BASELINE_ACCENT,
  baselineLabels,
  buildBaselinePlan,
  consentMarkdown,
  evaluateCallDuration,
  participantIdFor,
} from "./baseline-flow";

test("the accent vocabulary is the documented eight, defaulting to unspecified", () => {
  assert.deepEqual([...BASELINE_ACCENTS], [
    "en-US",
    "en-GB",
    "en-IN",
    "en-NG",
    "en-IE",
    "en-AU",
    "other",
    "unspecified",
  ]);
  assert.equal(DEFAULT_BASELINE_ACCENT, "unspecified");
});

test("the plan walks 3, 4 or 5 participants: call 1, a five-minute break, call 2", () => {
  for (const count of [3, 4, 5] as const) {
    const plan = buildBaselinePlan(count);
    assert.equal(plan.length, count * 3, `${count} participants have three steps each`);
    const expected: unknown[] = [];
    for (let index = 1; index <= count; index += 1) {
      const participantId = participantIdFor(index);
      expected.push(
        { kind: "call", participantId, call: 1 },
        { kind: "break", participantId, breakMs: 5 * 60 * 1000 },
        { kind: "call", participantId, call: 2 },
      );
    }
    assert.deepEqual(plan, expected);
  }
  assert.equal(participantIdFor(1), "participant-01");
  assert.equal(participantIdFor(5), "participant-05");
});

test("a call outside 4:00–6:00 is refused by name; both boundaries are inside", () => {  assert.deepEqual(evaluateCallDuration(4 * 60 * 1000), { ok: true });
  assert.deepEqual(evaluateCallDuration(6 * 60 * 1000), { ok: true });

  for (const [badMs, clock] of [
    [3 * 60 * 1000 + 59 * 1000, "3:59"],
    [6 * 60 * 1000 + 1000, "6:01"],
  ] as const) {
    const refusal = evaluateCallDuration(badMs);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, "wrong-duration-band");
    assert.match(refusal.message, new RegExp(clock));
    assert.match(refusal.message, /4:00/);
    assert.match(refusal.message, /6:00/);
  }
});

test(
  "a multi-megabyte take reaches ffprobe instead of dying in the spawn buffer",
  { skip: spawnSync("ffprobe", ["-version"], { encoding: "utf8" }).status !== 0 && "ffprobe is not on PATH" },
  () => {
    // A six-minute MediaRecorder WebM is several megabytes. The spawn buffer
    // must carry it to ffprobe; the refusal below is about the bytes not being
    // audio, never about the buffer.
    const bytes = Buffer.alloc(2 * 1024 * 1024);
    assert.throws(
      () => audioDurationMs(bytes, "webm"),
      (error: unknown) =>
        error instanceof BaselineError &&
        !/ENOBUFS/.test(error.message) &&
        !/not on PATH/.test(error.message),
    );
  },
);

test("labels are the documented pair per call, with the participant's accent", () => {
  assert.deepEqual(BASELINE_CALL_LABELS, {
    1: { intent: "booking-inquiry", emotion: "neutral" },
    2: { intent: "service-problem", emotion: "frustrated" },
  });
  assert.deepEqual(baselineLabels(1, "en-NG"), {
    intent: "booking-inquiry",
    emotion: "neutral",
    accent: "en-NG",
  });
  assert.deepEqual(baselineLabels(2, "unspecified"), {
    intent: "service-problem",
    emotion: "frustrated",
    accent: "unspecified",
  });
});

test("the consent pointer names the pseudonym, the server date and where the original is filed", () => {
  const text = consentMarkdown("participant-02", "2026-11-02");
  assert.match(text, /participant-02/);
  assert.match(text, /2026-11-02/);
  assert.match(text, /signed original filed by the owner outside the repository/i);
  assert.doesNotMatch(text, /name:|email:|phone:/i);
});

// ── The local surface ───────────────────────────────────────────────────────

async function withStudio(run: (studio: RunningStudio, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "voni-baseline-flow-"));
  let studio: RunningStudio | undefined;
  try {
    studio = await startStudio({ root, port: 0 });
    await run(studio, root);
  } finally {
    await studio?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("the setup endpoint publishes the fixed vocabulary the page renders", async () => {
  await withStudio(async (studio) => {
    const response = await fetch(`${studio.url}/api/baseline/setup`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      participantCounts: number[];
      accents: string[];
      defaultAccent: string;
      breakMs: number;
      minCallMs: number;
      maxCallMs: number;
      calls: Array<{ call: number; title: string; instruction: string }>;
      labels: Record<string, { intent: string; emotion: string }>;
    };
    assert.deepEqual(body.participantCounts, [3, 4, 5]);
    assert.deepEqual(body.accents, [...BASELINE_ACCENTS]);
    assert.equal(body.defaultAccent, "unspecified");
    assert.equal(body.breakMs, 5 * 60 * 1000);
    assert.equal(body.minCallMs, 4 * 60 * 1000);
    assert.equal(body.maxCallMs, 6 * 60 * 1000);
    assert.deepEqual(body.calls.map((call) => call.call), [1, 2]);
    assert.match(body.calls[0]!.title, /booking/i);
    assert.match(body.calls[1]!.title, /service problem/i);
    assert.deepEqual(body.labels, BASELINE_CALL_LABELS);
  });
});

type SessionBody = {
  participants: Array<{
    participantId: string;
    accent: string;
    consentRef: string;
    consentedAt: string;
  }>;
  plan: Array<{ kind: string; participantId: string; call?: number; breakMs?: number }>;
};

test("starting a session writes one consent pointer per participant from the attestation", async () => {
  await withStudio(async (studio, root) => {
    const response = await fetch(`${studio.url}/api/baseline/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participants: 3, accents: ["en-US", "en-GB", "unspecified"], attested: true }),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as SessionBody;

    assert.deepEqual(body.plan, buildBaselinePlan(3));
    assert.deepEqual(
      body.participants.map((participant) => [participant.participantId, participant.accent]),
      [
        ["participant-01", "en-US"],
        ["participant-02", "en-GB"],
        ["participant-03", "unspecified"],
      ],
    );

    for (const participant of body.participants) {
      assert.match(participant.consentedAt, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(participant.consentRef, `${participant.participantId}/consent.md`);
      const text = await readFile(join(root, "consent", participant.participantId, "consent.md"), "utf8");
      assert.match(text, new RegExp(participant.participantId));
      assert.match(text, new RegExp(participant.consentedAt));
      assert.match(text, /signed original filed by the owner outside the repository/i);
    }
  });
});

test("a session without the consent attestation writes no consent file", async () => {
  await withStudio(async (studio, root) => {
    const response = await fetch(`${studio.url}/api/baseline/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participants: 3, accents: ["unspecified", "unspecified", "unspecified"], attested: false }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "missing-attestation");
    await assert.rejects(readFile(join(root, "consent", "participant-01", "consent.md"), "utf8"), /ENOENT/);
  });
});

test("an unknown participant count or accent is refused by name, never defaulted", async () => {
  await withStudio(async (studio) => {
    for (const body of [
      { participants: 2, accents: ["en-US", "en-US"], attested: true },
      { participants: 3, accents: ["en-US", "en-US"], attested: true },
      { participants: 3, accents: ["en-US", "klingon", "en-US"], attested: true },
    ]) {
      const response = await fetch(`${studio.url}/api/baseline/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(((await response.json()) as { error: string }).error, "invalid-baseline-session");
    }
  });
});

/**
 * A tiny PCM WAV that *declares* the requested length: 1 kHz, mono, 8-bit, so
 * the byte rate is 1000 and the data size is the duration in milliseconds. The
 * Studio measures this header through the verifier's own durater.
 */
function callWav(durationMs: number): Buffer {
  const data = Buffer.alloc(Math.round(durationMs));
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

async function startSession(studio: RunningStudio): Promise<SessionBody> {
  const response = await fetch(`${studio.url}/api/baseline/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participants: 3, accents: ["en-US", "en-GB", "unspecified"], attested: true }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as SessionBody;
}

test("a landed baseline take carries the plan's labels and consent block exactly", async () => {
  await withStudio(async (studio) => {
    const session = await startSession(studio);
    const participant = session.participants[0]!;
    const audio = callWav(5 * 60 * 1000);
    const baseline = {
      participantId: participant.participantId,
      consentRef: participant.consentRef,
      consentedAt: participant.consentedAt,
      call: 1,
    };

    const response = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "upload",
        audioBase64: audio.toString("base64"),
        labels: baselineLabels(1, participant.accent),
        upload: { filename: `baseline-${participant.participantId}-call-1.wav` },
        baseline,
      }),
    });
    assert.equal(response.status, 201);
    const { take } = (await response.json()) as {
      take: { labels: Record<string, string>; baseline: typeof baseline; audioBytes: number };
    };
    assert.deepEqual(take.labels, { intent: "booking-inquiry", emotion: "neutral", accent: "en-US" });
    assert.deepEqual(take.baseline, baseline);
    assert.equal(take.audioBytes, audio.byteLength);
  });
});

test("a 3:59 or 6:01 baseline call is refused by name and leaves no take", async () => {
  await withStudio(async (studio) => {
    const session = await startSession(studio);
    const [first, second] = session.participants;

    async function post(participant: SessionBody["participants"][number], call: 1 | 2, durationMs: number) {
      return fetch(`${studio.url}/api/takes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "upload",
          audioBase64: callWav(durationMs).toString("base64"),
          labels: baselineLabels(call, participant.accent),
          upload: { filename: `baseline-${participant.participantId}-call-${call}.wav` },
          baseline: {
            participantId: participant.participantId,
            consentRef: participant.consentRef,
            consentedAt: participant.consentedAt,
            call,
          },
        }),
      });
    }

    const short = await post(first!, 1, 3 * 60 * 1000 + 59 * 1000);
    assert.equal(short.status, 400);
    const shortBody = (await short.json()) as { error: string; message: string };
    assert.equal(shortBody.error, "wrong-duration-band");
    assert.match(shortBody.message, /3:59/);

    const long = await post(second!, 2, 6 * 60 * 1000 + 1000);
    assert.equal(long.status, 400);
    const longBody = (await long.json()) as { error: string; message: string };
    assert.equal(longBody.error, "wrong-duration-band");
    assert.match(longBody.message, /6:01/);

    assert.equal(
      ((await (await fetch(`${studio.url}/api/takes`)).json()) as { takes: unknown[] }).takes.length,
      0,
      "a refused call is never stored",
    );

    assert.equal((await post(first!, 1, 4 * 60 * 1000)).status, 201);
    assert.equal((await post(second!, 2, 6 * 60 * 1000)).status, 201);
    assert.equal(
      ((await (await fetch(`${studio.url}/api/takes`)).json()) as { takes: unknown[] }).takes.length,
      2,
      "both band boundaries are inside",
    );
  });
});

async function landCompleteBaseline(studio: RunningStudio, session: SessionBody): Promise<void> {
  for (const participant of session.participants) {
    for (const call of [1, 2] as const) {
      const response = await fetch(`${studio.url}/api/takes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "upload",
          audioBase64: callWav(5 * 60 * 1000).toString("base64"),
          labels: baselineLabels(call, participant.accent),
          upload: { filename: `baseline-${participant.participantId}-call-${call}.wav` },
          baseline: {
            participantId: participant.participantId,
            consentRef: participant.consentRef,
            consentedAt: participant.consentedAt,
            call,
          },
        }),
      });
      assert.equal(response.status, 201, `${participant.participantId} call ${call}`);
    }
  }
}

type PinBody = {
  pinned: boolean;
  participants: number;
  manifestPath: string;
  takes: Array<{ participantId: string; call: number; takeId: string; audioSha256: string }>;
};

test("the finish button pins the existing hash list and verifies it, refusing a second pin", async () => {
  await withStudio(async (studio, root) => {
    const session = await startSession(studio);
    await landCompleteBaseline(studio, session);

    const first = await fetch(`${studio.url}/api/baseline/pin`, { method: "POST" });
    assert.equal(first.status, 200);
    const body = (await first.json()) as PinBody;
    assert.equal(body.pinned, true);
    assert.equal(body.participants, 3);
    assert.equal(body.takes.length, 6);
    assert.equal(body.manifestPath, join(root, "baseline-hashes.json"));
    assert.deepEqual(
      body.takes.map((take) => [take.participantId, take.call]),
      [
        ["participant-01", 1],
        ["participant-01", 2],
        ["participant-02", 1],
        ["participant-02", 2],
        ["participant-03", 1],
        ["participant-03", 2],
      ],
    );
    for (const take of body.takes) assert.match(take.audioSha256, /^[0-9a-f]{64}$/);

    const manifest = JSON.parse(await readFile(body.manifestPath, "utf8")) as { takes: unknown[] };
    assert.equal(manifest.takes.length, 6);

    const second = await fetch(`${studio.url}/api/baseline/pin`, { method: "POST" });
    assert.equal(second.status, 409);
    const refusal = (await second.json()) as { error: string; message: string };
    assert.equal(refusal.error, "manifest-exists");
    assert.match(refusal.message, /never re-written/);
  });
});

test("the finish button refuses an empty baseline by name, never pinning it", async () => {
  await withStudio(async (studio) => {
    const response = await fetch(`${studio.url}/api/baseline/pin`, { method: "POST" });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, "missing-take");
    assert.match(body.message, /not captured/);
  });
});

test("the baseline page has no text input anywhere, only taps", async () => {
  await withStudio(async (studio) => {
    const response = await fetch(`${studio.url}/baseline`);
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /Baseline/);
    assert.match(html, /participant-01/);
    assert.doesNotMatch(html, /<textarea/i, "no free-text field on the baseline flow");
    assert.doesNotMatch(html, /type=["']text["']/i);
    assert.doesNotMatch(html, /type=["']date["']/i);
    assert.doesNotMatch(html, /type=["']number["']/i);
    for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
      assert.match(input[0], /type=["']checkbox["']/i, `only a checkbox may appear: ${input[0]}`);
    }

    // The page drives the existing take route and the baseline routes; it
    // invents neither a second recorder nor a second store.
    for (const route of ["/api/baseline/setup", "/api/baseline/session", "/api/baseline/pin", "/api/takes"]) {
      assert.ok(html.includes(route), `the page calls ${route}`);
    }
    assert.match(html, /MediaRecorder/);
    assert.match(html, /getUserMedia/);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost|127\.0\.0\.1)/, "the surface loads nothing from a remote origin");
  });
});

test("every Studio surface links the baseline flow from its nav", async () => {
  await withStudio(async (studio) => {
    for (const path of ["/", "/rate", "/corpus", "/baseline"]) {
      const html = await (await fetch(`${studio.url}${path}`)).text();
      assert.match(html, /href="\/baseline"/, `${path} links the baseline flow`);
      assert.match(html, /href="\/corpus"/, `${path} still links the corpus baseline form`);
    }
  });
});
