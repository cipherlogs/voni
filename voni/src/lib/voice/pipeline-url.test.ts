import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_CALL_PATH,
  PIPELINE_URL_ENV,
  PipelineUrlError,
  deriveBrowserCallUrl,
  pipelineUrlFromEnv,
  readPipelineUrl,
} from "./pipeline-url";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(here, "../../..");

test("an https base derives the browser call URL at the service's connect path", () => {
  const result = readPipelineUrl("https://pipeline.example.com");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.baseUrl, "https://pipeline.example.com");
  assert.equal(result.wsUrl, `wss://pipeline.example.com${BROWSER_CALL_PATH}`);
  assert.equal(result.wsUrl, "wss://pipeline.example.com/v1/browser-call");
});

test("a non-default port survives the derivation", () => {
  const result = readPipelineUrl("https://pipeline.example.com:8766");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.baseUrl, "https://pipeline.example.com:8766");
  assert.equal(
    result.wsUrl,
    "wss://pipeline.example.com:8766/v1/browser-call",
  );
});

test("a path prefix survives the derivation, with no double slash", () => {
  const result = readPipelineUrl("https://pipeline.example.com/voice");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.baseUrl, "https://pipeline.example.com/voice");
  assert.equal(
    result.wsUrl,
    "wss://pipeline.example.com/voice/v1/browser-call",
  );

  const trailing = readPipelineUrl("https://pipeline.example.com/voice/");
  assert.equal(trailing.ok, true);
  if (!trailing.ok) return;
  assert.equal(trailing.baseUrl, "https://pipeline.example.com/voice");
  assert.equal(
    trailing.wsUrl,
    "wss://pipeline.example.com/voice/v1/browser-call",
  );
  assert.doesNotMatch(trailing.wsUrl, /\/\/voice/);
});

test("port and prefix together derive one unambiguous URL", () => {
  const derived = deriveBrowserCallUrl("https://pipeline.example.com:8443/v/one/");
  assert.equal(derived, "wss://pipeline.example.com:8443/v/one/v1/browser-call");
});

test("the default https port is not restated", () => {
  const result = readPipelineUrl("https://pipeline.example.com:443");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.wsUrl, "wss://pipeline.example.com/v1/browser-call");
});

test("a missing URL is a named unavailable result, never a localhost default", () => {
  for (const raw of [undefined, null, "", "   "]) {
    const result = readPipelineUrl(raw);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.ok(result.error instanceof PipelineUrlError);
    assert.equal(result.error.code, "missing");
    assert.match(result.error.message, new RegExp(PIPELINE_URL_ENV));
    assert.doesNotMatch(result.error.message, /localhost|127\.0\.0\.1/);
  }
});

test("a non-https URL is refused at configuration time by name", () => {
  for (const raw of [
    "http://pipeline.example.com",
    "http://127.0.0.1:8766",
    "ws://pipeline.example.com/v1/browser-call",
    "wss://pipeline.example.com/v1/browser-call",
  ]) {
    const result = readPipelineUrl(raw);
    assert.equal(result.ok, false, raw);
    if (result.ok) continue;
    assert.equal(result.error.code, "insecure", raw);
    assert.match(result.error.message, /https/i, raw);
    assert.throws(
      () => deriveBrowserCallUrl(raw),
      (error: unknown) =>
        error instanceof PipelineUrlError && error.code === "insecure",
      raw,
    );
  }
});

test("a value that is not a base URL is refused as invalid", () => {
  for (const raw of [
    "pipeline.example.com",
    "https://",
    "https://pipeline.example.com/base?tenant=1",
    "https://pipeline.example.com/base#frag",
    "https://user:pass@pipeline.example.com",
  ]) {
    const result = readPipelineUrl(raw);
    assert.equal(result.ok, false, raw);
    if (result.ok) continue;
    assert.equal(result.error.code, "invalid", raw);
  }
});

test("the runtime reader takes the server variable and ignores the old public one", async () => {
  const savedNew = process.env[PIPELINE_URL_ENV];
  const savedOld = process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL;
  try {
    process.env[PIPELINE_URL_ENV] = "https://pipeline.example.com:9443/voice";
    process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL =
      "ws://127.0.0.1:8766/v1/browser-call";

    const configured = await pipelineUrlFromEnv();
    assert.equal(configured.ok, true);
    if (!configured.ok) return;
    assert.equal(
      configured.wsUrl,
      "wss://pipeline.example.com:9443/voice/v1/browser-call",
    );

    delete process.env[PIPELINE_URL_ENV];
    const missing = await pipelineUrlFromEnv();
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.error.code, "missing");
  } finally {
    if (savedNew === undefined) delete process.env[PIPELINE_URL_ENV];
    else process.env[PIPELINE_URL_ENV] = savedNew;
    if (savedOld === undefined) delete process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL;
    else process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL = savedOld;
  }
});

test("no app source reads a build-time public pipeline URL", () => {
  const voiceCall = readFileSync(
    join(APP_ROOT, "src/components/voice-call.tsx"),
    "utf8",
  );
  assert.doesNotMatch(voiceCall, /NEXT_PUBLIC_VOICE_PIPELINE_URL/);
  assert.doesNotMatch(
    voiceCall,
    /ws:\/\/127\.0\.0\.1:8766/,
    "no localhost pipeline default remains in the client",
  );

  const envDoc = readFileSync(join(APP_ROOT, "ENVIRONMENT.md"), "utf8");
  assert.doesNotMatch(envDoc, /NEXT_PUBLIC_VOICE_PIPELINE_URL/);
  assert.match(envDoc, new RegExp(PIPELINE_URL_ENV));
});

test("the hidden cascade page supplies the URL from the server, not the build", () => {
  const page = readFileSync(
    join(APP_ROOT, "src/app/e2e/cascade/page.tsx"),
    "utf8",
  );
  assert.match(page, /pipelineUrlFromEnv/);
  assert.match(page, /cascadeUrl=/);
  assert.doesNotMatch(page, /NEXT_PUBLIC_VOICE_PIPELINE_URL/);
});
