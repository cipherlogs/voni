/**
 * The Studio's local HTTP surface: the Record page talks to these routes.
 *
 * The tests drive real requests against a bound loopback server — the same
 * thing the browser does — so "refuses a production request by name" is
 * proven on the wire, not by reading a flag. Every take still lands in the
 * take store; the surface adds no second writer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Certificate } from "../../src/lib/demo/verification/certificate/types";
import { sha256Hex } from "../../src/lib/demo/verification/scenarios/digest";
import { StudioError } from "./take-store";
import { assertLocalOnly, isLoopbackHost, startStudio, type RunningStudio } from "./http";

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

const LABELS = { intent: "ask a question", emotion: "neutral", accent: "Australian English" };

/**
 * A tiny PCM WAV that *declares* the requested length: 1 kHz, mono, 8-bit, so
 * the byte rate is 1000 and the data size is the duration in milliseconds. A
 * baseline take is now gated to 4–6 minutes at landing.
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

async function withStudio(
  run: (studio: RunningStudio, root: string) => Promise<void>,
  dialoguesDir?: string,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "voni-studio-http-"));
  let studio: RunningStudio | undefined;
  try {
    studio = await startStudio({ root, port: 0, ...(dialoguesDir ? { dialoguesDir } : {}) });
    await run(studio, root);
  } finally {
    await studio?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function refusal(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof StudioError, `expected StudioError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2);
    return true;
  };
}

test("the record page is served at the loopback root", async () => {
  await withStudio(async (studio) => {
    const response = await fetch(`${studio.url}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Studio/);
    assert.match(html, /Record/);
    assert.match(html, /one-shot/i);
    assert.match(html, /dialogue/i);
    assert.match(html, /upload/i);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost|127\.0\.0\.1)/, "the surface loads nothing from a remote origin");
  });
});

test("a one-shot POST lands a take, the list returns it and the audio is served by hash", async () => {
  await withStudio(async (studio) => {
    const bytes = wav(16);
    const response = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "one-shot",
        audioBase64: bytes.toString("base64"),
        labels: LABELS,
        prompt: { text: "Hi, is this Voni?" },
      }),
    });
    assert.equal(response.status, 201);
    const { take } = (await response.json()) as { take: { takeId: string; audioSha256: string } };
    assert.equal(take.takeId, "take-000001");
    assert.match(take.audioSha256, /^[0-9a-f]{64}$/);

    const listed = (await (await fetch(`${studio.url}/api/takes`)).json()) as { takes: unknown[] };
    assert.equal(listed.takes.length, 1);

    const audio = await fetch(`${studio.url}/api/takes/${take.takeId}/audio`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/wav");
    assert.equal(audio.headers.get("x-take-sha256"), take.audioSha256);
    assert.equal(Buffer.from(await audio.arrayBuffer()).toString("hex"), bytes.toString("hex"));
  });
});

test("an upload and a dialogue turn each land through the same route", async () => {
  await withStudio(async (studio) => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("upload")]);
    const uploaded = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "upload",
        audioBase64: webm.toString("base64"),
        labels: LABELS,
        upload: { filename: "caller.webm" },
      }),
    });
    assert.equal(uploaded.status, 201);
    assert.equal(((await uploaded.json()) as { take: { audioFormat: string } }).take.audioFormat, "webm");

    const dialogue = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "dialogue",
        audioBase64: wav().toString("base64"),
        labels: LABELS,
        prompt: { dialogue: "booking-basic", line: "open", turn: 1, text: "Hi, I'd like to book." },
      }),
    });
    assert.equal(dialogue.status, 201);
    const { take } = (await dialogue.json()) as { take: { source: unknown } };
    assert.deepEqual(take.source, {
      mode: "dialogue",
      prompt: { dialogue: "booking-basic", line: "open", turn: 1, text: "Hi, I'd like to book." },
    });
  });
});

test("labels are required on the wire; a missing label is a named 400, not an invented value", async () => {
  await withStudio(async (studio) => {
    const response = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "one-shot",
        audioBase64: wav().toString("base64"),
        labels: { intent: "book", accent: "Irish English" },
        prompt: { text: "Hi" },
      }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, "missing-label");
    assert.match(body.message, /emotion/);
    assert.equal(((await (await fetch(`${studio.url}/api/takes`)).json()) as { takes: unknown[] }).takes.length, 0);
  });
});

test("a production hostname is refused by name before any take is touched", async () => {
  await withStudio(async (studio) => {
    // fetch forbids a custom Host header, so speak HTTP/1.1 directly: the
    // refusal is about the wire request, not about a client library's policy.
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: studio.port,
          path: "/api/takes",
          method: "POST",
          headers: { host: "voni.example.com", "content-type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      request.on("error", reject);
      request.end(
        JSON.stringify({
          mode: "one-shot",
          audioBase64: wav().toString("base64"),
          labels: LABELS,
          prompt: { text: "Hi" },
        }),
      );
    });
    assert.equal(result.status, 403);
    const body = JSON.parse(result.body) as { error: string; message: string };
    assert.equal(body.error, "studio-not-local");
    assert.match(body.message, /voni\.example\.com/);
    assert.match(body.message, /local-only/);
    assert.equal(((await (await fetch(`${studio.url}/api/takes`)).json()) as { takes: unknown[] }).takes.length, 0);
  });
});

test("the Studio refuses to start in a production environment", () => {
  assert.throws(() => assertLocalOnly({ NODE_ENV: "production" }), refusal("studio-not-local", /local-only/));
  assert.throws(() => assertLocalOnly({ VONI_STUDIO_TARGET: "production" }), refusal("studio-not-local", /production/));
  assert.doesNotThrow(() => assertLocalOnly({ NODE_ENV: "development" }));
  assert.doesNotThrow(() => assertLocalOnly({}));
});

test("only loopback hostnames are accepted", () => {
  for (const host of ["localhost", "localhost:4317", "127.0.0.1:4317", "[::1]:4317", "127.0.0.1"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["voni.example.com", "voni.example.com:443", "10.0.0.4:4317", "", undefined]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test("dialogue scripts are listed with their prompt cards, and a malformed script is refused by name", async () => {
  const dialogues = await mkdtemp(join(tmpdir(), "voni-studio-dialogues-"));
  try {
    await writeFile(
      join(dialogues, "booking-basic.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "booking-basic",
        locale: "en",
        turns: [
          { line: "open", text: "Hi, I'd like to book a table." },
          { line: "time", text: "Friday at seven, please." },
        ],
      }),
    );
    await withStudio(async (studio) => {
      const response = await fetch(`${studio.url}/api/dialogues`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        dialogues: Array<{ name: string; turns: Array<{ line: string; text: string; turn: number }> }>;
      };
      assert.equal(body.dialogues.length, 1);
      assert.equal(body.dialogues[0].name, "booking-basic");
      assert.deepEqual(body.dialogues[0].turns, [
        { line: "open", text: "Hi, I'd like to book a table.", turn: 1 },
        { line: "time", text: "Friday at seven, please.", turn: 2 },
      ]);

      await writeFile(join(dialogues, "broken.json"), JSON.stringify({ name: "broken", turns: [] }));
      const broken = await fetch(`${studio.url}/api/dialogues`);
      assert.equal(broken.status, 500);
      const brokenBody = (await broken.json()) as { error: string; message: string };
      assert.equal(brokenBody.error, "malformed-dialogue");
      assert.match(brokenBody.message, /broken\.json/);
    }, dialogues);
  } finally {
    await rm(dialogues, { recursive: true, force: true });
  }
});

test("an unknown route is a named 404 and a non-GET/POST method is refused", async () => {
  await withStudio(async (studio) => {
    const missing = await fetch(`${studio.url}/api/does-not-exist`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: string }).error, "unknown-route");

    const method = await fetch(`${studio.url}/api/takes`, { method: "DELETE" });
    assert.equal(method.status, 405);
    assert.equal(((await method.json()) as { error: string }).error, "method-not-allowed");
  });
});

test("a malformed JSON body is refused by name, never treated as an empty take", async () => {
  await withStudio(async (studio) => {
    const response = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "invalid-body");
  });
});

// ── Rate: blind playback and attributable ratings ───────────────────────────

const RATE_CALL_WAV = wav(16);
const RATE_BASELINE_WAV = wav(48);

function rateCertificate(calls: readonly string[], failing = false): Certificate {
  const rows = [
    {
      locale: "en" as const,
      scenario: "booking",
      class: "golden-flow" as const,
      heldOut: false,
      requiredRepetitions: 1,
      measuredRepetitions: calls.length,
      status: "measured" as const,
      gap: null,
      calls,
    },
  ];
  return {
    schemaVersion: 3,
    scope: {
      locales: ["en"],
      decidedBy: "owner",
      decidedOn: "2026-11-02",
      reason: "English-only launch",
    },
    resume: null,
    runId: "run-http-rating",
    target: "local",
    code: {
      fingerprint: { head: "abc123", dirty: false, dirtyHash: "clean" },
      appBuild: "app-build-1",
      pipelineImage: "pipeline-image-1",
    },
    corpus: { version: 1, sha256: "c".repeat(64) },
    vendorBuilds: [
      { leg: "stt", vendor: "vendor-a", model: "model-a", buildId: "build-a" },
      { leg: "tts", vendor: "vendor-b", model: "model-b", buildId: "build-b" },
      { leg: "llm", vendor: "vendor-c", model: "model-c", buildId: "build-c" },
    ],
    plan: { mode: "nightly", repetitions: 1 },
    coverage: {
      expectedScenarios: 1,
      gapRows: 0,
      rows,
      byLocale: [
        { locale: "en", expectedScenarios: 1, measuredScenarios: 1, gapRows: 0, status: "measured", gap: null, decision: null },
      ],
    },
    properties: [
      {
        propertyId: "T1",
        family: "turn-taking",
        status: failing ? "FAIL" : "PASS",
        reason: failing ? "below-bar" : "pass",
        sampleCount: 1,
        citations: ["turn-taking"],
        gaps: [],
        scenarios: failing
          ? [{ scenario: "booking", locale: "en", status: "FAIL", reason: "below-bar", sampleCount: 1, citations: ["booking#1"] }]
          : [],
      },
    ],
    eligibility: { eligible: true, reasons: [] },
    runFailures: [],
    cost: { usd: 0.1, callCount: calls.length },
    residualRiskIds: ["RR-01"],
    panel: null,
    verdict: failing ? "not-demo-ready" : "pending-human",
    pass: false,
  };
}

function rateCall(baseline = true): Record<string, unknown> {
  return {
    callId: "call-1",
    scenario: "booking",
    locale: "en",
    transcript: [
      { speaker: "caller", text: "Hi, is this Voni?", atMs: 0 },
      { speaker: "agent", text: "Hello, thanks for calling.", atMs: 500 },
    ],
    timeline: [
      { atMs: 0, type: "call-open" },
      { atMs: 500, type: "agent-speech-start" },
      { atMs: 1800, type: "call-end" },
    ],
    audio: { path: "calls/call-1.wav", sha256: sha256Hex(RATE_CALL_WAV) },
    ...(baseline ? { baseline: { path: "baseline/call-1.wav", sha256: sha256Hex(RATE_BASELINE_WAV) } } : {}),
  };
}

async function withRateStudio(run: (studio: RunningStudio) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "voni-rate-http-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "voni-rate-evidence-"));
  let studio: RunningStudio | undefined;
  try {
    await mkdir(join(evidenceRoot, "calls"), { recursive: true });
    await mkdir(join(evidenceRoot, "baseline"), { recursive: true });
    await writeFile(join(evidenceRoot, "calls", "call-1.wav"), RATE_CALL_WAV);
    await writeFile(join(evidenceRoot, "baseline", "call-1.wav"), RATE_BASELINE_WAV);
    studio = await startStudio({ root, port: 0, evidenceRoot });
    await run(studio);
  } finally {
    await studio?.close();
    await rm(root, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  }
}

test("the Rate page is served and lists the seven axes without a verdict or model identity", async () => {
  await withRateStudio(async (studio) => {
    const page = await fetch(`${studio.url}/rate`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Rate/);
    assert.match(html, /blind/i);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost|127\.0\.0\.1)/);

    const axes = (await (await fetch(`${studio.url}/api/rate/axes`)).json()) as {
      axes: Array<{ id: string; label: string }>;
    };
    assert.equal(axes.axes.length, 7);
    assert.match(JSON.stringify(axes), /stayOnCall/);
  });
});

test("a rating session is created from a certificate and returns a blind queue", async () => {
  await withRateStudio(async (studio) => {
    const response = await fetch(`${studio.url}/api/rate/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewer: "owner",
        seed: 7,
        certificate: rateCertificate(["call-1"]),
        calls: [rateCall()],
      }),
    });
    assert.equal(response.status, 201);
    const { session } = (await response.json()) as {
      session: { sessionId: string; reviewer: string; date: string; queue: Array<{ itemId: string }> };
    };
    assert.match(session.sessionId, /^rating-[0-9a-f]{64}$/);
    assert.equal(session.reviewer, "owner");
    assert.match(session.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(session.queue.length, 1);

    const serialized = JSON.stringify(session);
    assert.doesNotMatch(serialized, /PASS|FAIL|certified|not-demo-ready|pending-human|model|vendor|sha256|call-1|booking/);

    const fetched = await fetch(`${studio.url}/api/rate/sessions/${session.sessionId}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual((await fetched.json()) as unknown, { session });

    const callAudio = await fetch(`${studio.url}/api/rate/sessions/${session.sessionId}/items/${session.queue[0]!.itemId}/call`);
    assert.equal(callAudio.status, 200);
    assert.equal(callAudio.headers.get("content-type"), "audio/wav");
    assert.equal(callAudio.headers.get("x-take-sha256"), null, "the blind surface never exposes a hash");

    for (const side of ["a", "b"]) {
      const audio = await fetch(`${studio.url}/api/rate/sessions/${session.sessionId}/items/${session.queue[0]!.itemId}/ab/${side}`);
      assert.equal(audio.status, 200);
      assert.equal(audio.headers.get("x-take-sha256"), null);
    }
  });
});

test("a rating over HTTP needs all seven axes, is attributed, and refuses a second filing", async () => {
  await withRateStudio(async (studio) => {
    const created = await fetch(`${studio.url}/api/rate/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewer: "owner",
        seed: 7,
        certificate: rateCertificate(["call-1"], true),
        calls: [rateCall()],
      }),
    });
    const { session } = (await created.json()) as {
      session: { sessionId: string; queue: Array<{ itemId: string }> };
    };
    const itemId = session.queue[0]!.itemId;

    const missingAxis = await fetch(`${studio.url}/api/rate/sessions/${session.sessionId}/ratings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, axes: { stayOnCall: 4 } }),
    });
    assert.equal(missingAxis.status, 400);
    assert.equal(((await missingAxis.json()) as { error: string }).error, "missing-axis");

    const axes = {
      stayOnCall: 4,
      soundsHuman: 4,
      turnTaking: 3,
      understanding: 5,
      languageNaturalness: 4,
      warmth: 4,
      pacing: 3,
    };
    const first = await fetch(`${studio.url}/api/rate/sessions/${session.sessionId}/ratings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        itemId,
        axes,
        freeText: "Clear but a little slow.",
        defectTags: ["slow-greeting"],
        humanSide: "A",
        preferredSide: "B",
      }),
    });
    assert.equal(first.status, 201);
    const { rating } = (await first.json()) as { rating: { reviewer: string; sessionId: string; callId: string } };
    assert.equal(rating.reviewer, "owner");
    assert.equal(rating.sessionId, session.sessionId);
    assert.equal(rating.callId, "call-1");

    const again = await fetch(`${studio.url}/api/rate/sessions/${session.sessionId}/ratings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, axes, humanSide: "A", preferredSide: "B" }),
    });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "rating-already-filed");

    const listed = (await (await fetch(`${studio.url}/api/rate/sessions/${session.sessionId}/ratings`)).json()) as {
      ratings: unknown[];
    };
    assert.equal(listed.ratings.length, 1);

    const exported = (await (await fetch(`${studio.url}/api/rate/sessions/${session.sessionId}/export`)).json()) as {
      sessionId: string;
      reviewer: string;
      signedAt: string;
      ratings: unknown[];
    };
    assert.equal(exported.sessionId, session.sessionId);
    assert.equal(exported.reviewer, "owner");
    assert.match(exported.signedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(exported.ratings.length, 1);
  });
});

// ── Corpus: browse, hash, retire ────────────────────────────────────────────

test("the Corpus page is served on loopback and browses takes with their hashes", async () => {
  await withStudio(async (studio) => {
    const page = await fetch(`${studio.url}/corpus`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Corpus/);
    assert.match(html, /sha256/i);
    assert.match(html, /Retire/i);
    assert.match(html, /baseline/i);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost|127\.0\.0\.1)/);

    const landed = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "one-shot",
        audioBase64: wav(16).toString("base64"),
        labels: LABELS,
        prompt: { text: "Hi" },
      }),
    });
    const { take } = (await landed.json()) as { take: { takeId: string; audioSha256: string } };

    const corpus = (await (await fetch(`${studio.url}/api/corpus`)).json()) as {
      takes: Array<{ record: { takeId: string; audioSha256: string }; retirement: unknown; selectable: boolean }>;
    };
    assert.equal(corpus.takes.length, 1);
    assert.equal(corpus.takes[0].record.audioSha256, take.audioSha256);
    assert.equal(corpus.takes[0].retirement, null);
    assert.equal(corpus.takes[0].selectable, true);
  });
});

test("retiring over HTTP marks the take, keeps its audio and removes it from selection", async () => {
  await withStudio(async (studio) => {
    const landed = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "one-shot",
        audioBase64: wav(16).toString("base64"),
        labels: LABELS,
        prompt: { text: "Hi" },
      }),
    });
    const { take } = (await landed.json()) as { take: { takeId: string; audioSha256: string } };

    const retired = await fetch(`${studio.url}/api/takes/${take.takeId}/retire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "owner", reason: "wrong accent for the scenario" }),
    });
    assert.equal(retired.status, 201);
    const { retirement } = (await retired.json()) as {
      retirement: { takeId: string; audioSha256: string; reviewer: string };
    };
    assert.equal(retirement.takeId, take.takeId);
    assert.equal(retirement.audioSha256, take.audioSha256);
    assert.equal(retirement.reviewer, "owner");

    const audio = await fetch(`${studio.url}/api/takes/${take.takeId}/audio`);
    assert.equal(audio.status, 200, "a retired take is never deleted");
    assert.equal(audio.headers.get("x-take-sha256"), take.audioSha256);

    const corpus = (await (await fetch(`${studio.url}/api/corpus`)).json()) as {
      takes: Array<{ record: { takeId: string }; retirement: { reviewer: string } | null; selectable: boolean }>;
    };
    assert.equal(corpus.takes[0].retirement?.reviewer, "owner");
    assert.equal(corpus.takes[0].selectable, false);

    const again = await fetch(`${studio.url}/api/takes/${take.takeId}/retire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "owner", reason: "again" }),
    });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "already-retired");
  });
});

test("a baseline take records consent metadata over HTTP and is never selectable", async () => {
  await withStudio(async (studio) => {
    const baseline = {
      participantId: "p-02",
      consentRef: "consent-2026-10-31-p02",
      consentedAt: "2026-10-31",
      call: 1,
    };
    const response = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "upload",
        audioBase64: callWav(5 * 60 * 1000).toString("base64"),
        labels: { ...LABELS, accent: "Nigerian English" },
        upload: { filename: "baseline-p02-call-1.wav" },
        baseline,
      }),
    });
    assert.equal(response.status, 201);
    const { take } = (await response.json()) as { take: { takeId: string; baseline: typeof baseline } };
    assert.deepEqual(take.baseline, baseline);

    const corpus = (await (await fetch(`${studio.url}/api/corpus`)).json()) as {
      takes: Array<{ record: { takeId: string; baseline?: unknown }; selectable: boolean }>;
    };
    assert.deepEqual(corpus.takes[0].record.baseline, baseline);
    assert.equal(corpus.takes[0].selectable, false);

    const missing = await fetch(`${studio.url}/api/takes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "upload",
        audioBase64: wav(32).toString("base64"),
        labels: LABELS,
        upload: { filename: "baseline-p03.wav" },
        baseline: { participantId: "p-03", consentedAt: "2026-10-31", call: 1 },
      }),
    });
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as { error: string }).error, "missing-baseline-consent");
  });
});
