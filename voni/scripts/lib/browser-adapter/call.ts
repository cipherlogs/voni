/**
 * The default browser call: spawn the one Playwright spec that drives Chromium
 * against the real landing page.
 *
 * The runner owns the scenario, the target and the evidence directories; the
 * spec owns the page, the synthetic microphone and the real client. The two
 * meet at one JSON invocation and one JSON result, so the runner's verdict
 * wiring is testable without a browser and the browser half is testable without
 * a verdict.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "The certifying test is the
 * visitor's path".
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { voiceForLocale } from "../protocol-adapter/transport";
import { SOUNDSCAPE_SAMPLE_RATE } from "../soundscapes";
import { BrowserAdapterError } from "./errors";
import { pcm16ToBase64, type SyntheticMicTake } from "./synthetic-mic";
import type { BrowserCallInput, BrowserCallResult } from "./types";

const VONI_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The default whole-browser bound; the measured browser phase has its own ceiling. */
export const DEFAULT_BROWSER_CALL_TIMEOUT_MS = 180_000;

/** The spec reads this file and writes that one. */
export const INVOCATION_FILE = "browser-invocation.json";
export const RESULT_FILE = "browser-call.json";

export type BrowserInvocationTake = {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly text: string | null;
  readonly sampleRate: number;
  readonly pcmBase64: string;
  readonly durationMs: number;
};

export type BrowserInvocation = {
  readonly schemaVersion: 1;
  readonly scenario: string;
  readonly locale: string;
  readonly voice: string;
  readonly appUrl: string;
  readonly pipelineUrl: string;
  readonly capturesDir: string;
  readonly eventsDir: string;
  readonly resultPath: string;
  readonly takes: readonly BrowserInvocationTake[];
  /** The ambience the harness mixes under the caller, or null for quiet-room. */
  readonly soundscape: BrowserInvocationSoundscape | null;
  readonly script: unknown;
  readonly faults: unknown;
  /** How long the harness keeps the line open before hanging up. */
  readonly holdOpenMs: number | null;
  readonly edge: unknown;
};

export type BrowserInvocationSoundscape = {
  readonly id: string;
  /** Mix level in dB; null means the adapter's documented default. */
  readonly levelDb: number | null;
  readonly sampleRate: number;
  readonly pcmBase64: string;
};

/** A standard PCM16 mono WAV's data chunk and rate. */
export function readTakePcm(file: string): { pcm: Uint8Array; sampleRate: number; durationMs: number } {
  const bytes = readFileSync(file);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new BrowserAdapterError("corpus-refused", `take ${file} is not a RIFF/WAVE file`);
  }
  let at = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const payload = at + 8;
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(payload + 2);
      sampleRate = bytes.readUInt32LE(payload + 4);
      bits = bytes.readUInt16LE(payload + 14);
    } else if (id === "data") {
      data = bytes.subarray(payload, payload + size);
      break;
    }
    at = payload + size + (size % 2);
  }
  if (data === null || sampleRate <= 0 || channels !== 1 || bits !== 16) {
    throw new BrowserAdapterError(
      "corpus-refused",
      `take ${file} is not mono 16-bit PCM at a usable rate (${channels} channel(s), ${bits}-bit, ${sampleRate} Hz)`,
    );
  }
  return {
    pcm: new Uint8Array(data),
    sampleRate,
    durationMs: (data.length / 2 / sampleRate) * 1000,
  };
}

/** Build the invocation the spec reads, including the caller takes. */
export async function buildBrowserInvocation(input: {
  readonly call: BrowserCallInput;
  readonly runDir: string;
}): Promise<{ invocation: BrowserInvocation; takes: SyntheticMicTake[] }> {
  const takes: BrowserInvocationTake[] = [];
  const micTakes: SyntheticMicTake[] = [];
  for (const take of input.call.scenario.takes) {
    const parsed = readTakePcm(take.path);
    const actual = createHash("sha256").update(await readFile(take.path)).digest("hex");
    if (actual !== take.sha256) {
      throw new BrowserAdapterError(
        "corpus-refused",
        `take "${take.id}" changed on disk: declared ${take.sha256}, file ${take.path} is ${actual}`,
      );
    }
    const encoded = pcm16ToBase64(parsed.pcm);
    takes.push({
      id: take.id,
      path: take.path,
      sha256: take.sha256,
      text: take.text ?? null,
      sampleRate: parsed.sampleRate,
      pcmBase64: encoded,
      durationMs: parsed.durationMs,
    });
    micTakes.push({ id: take.id, pcmBase64: encoded, sampleRate: parsed.sampleRate });
  }
  const resultPath = join(input.runDir, RESULT_FILE);
  const soundscapePcm = input.call.soundscapePcm ?? null;
  const invocation: BrowserInvocation = {
    schemaVersion: 1,
    scenario: input.call.scenario.name,
    locale: input.call.scenario.locale,
    voice: voiceForLocale(input.call.scenario.locale),
    appUrl: input.call.target.appUrl,
    pipelineUrl: input.call.target.pipelineUrl,
    capturesDir: input.call.capturesDir,
    eventsDir: input.call.eventsDir,
    resultPath,
    takes,
    soundscape:
      soundscapePcm === null
        ? null
        : {
            id: input.call.scenario.soundscape.id,
            levelDb: input.call.soundscapeLevelDb ?? null,
            sampleRate: SOUNDSCAPE_SAMPLE_RATE,
            pcmBase64: pcm16ToBase64(soundscapePcm),
          },
    script: input.call.scenario.script,
    faults: input.call.scenario.faults,
    holdOpenMs: input.call.scenario.holdOpenMs ?? null,
    edge: input.call.scenario.edge,
  };
  return { invocation, takes: micTakes };
}

function tail(text: string, lines = 40): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/**
 * Run the one Playwright spec and read its report. A browser that never
 * finished is a named refusal; the runner never retries.
 */
export async function runPlaywrightBrowserCall(
  input: BrowserCallInput,
  options: { readonly timeoutMs?: number; readonly cwd?: string } = {},
): Promise<BrowserCallResult> {
  const { invocation } = await buildBrowserInvocation({ call: input, runDir: input.runDir });
  const invocationPath = join(input.runDir, INVOCATION_FILE);
  await mkdir(input.runDir, { recursive: true });
  await writeFile(invocationPath, `${JSON.stringify(invocation, null, 2)}\n`, "utf8");
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_CALL_TIMEOUT_MS;
  const env = {
    ...process.env,
    ...input.env,
    PLAYWRIGHT_BASE_URL: input.target.appUrl,
    VONI_BROWSER_INVOCATION: invocationPath,
  };
  const cwd = options.cwd ?? VONI_ROOT;

  const output: string[] = [];
  const child = spawn(
    "npx",
    [
      "playwright",
      "test",
      "-c",
      "playwright.config.ts",
      "--project=desktop",
      "tests/e2e/browser-adapter.spec.ts",
    ],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.push(String(error));
      resolve({ code: 1, timedOut: false });
    });
  });

  if (outcome.timedOut) {
    throw new BrowserAdapterError(
      "call-timeout",
      `the browser call exceeded ${timeoutMs}ms; the run is refused, never retried. ` +
        `Browser output:\n${tail(output.join(""))}`,
    );
  }
  if (outcome.code !== 0) {
    throw new BrowserAdapterError(
      "call-refused",
      `the browser harness failed (exit ${outcome.code ?? 1}). Browser output:\n` +
        tail(output.join("")),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(invocation.resultPath, "utf8")) as unknown;
  } catch (error) {
    throw new BrowserAdapterError(
      "call-refused",
      `the browser harness finished but wrote no readable report at ${invocation.resultPath}: ` +
        `${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrowserAdapterError(
      "call-refused",
      `the browser report at ${invocation.resultPath} is not a JSON object`,
    );
  }
  return parsed as BrowserCallResult;
}
