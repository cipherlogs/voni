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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
