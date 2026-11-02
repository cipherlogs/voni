/**
 * The command surface: `demo:usage --run <id>` and `--latest` print a ledger
 * and exit 0; bad input and missing evidence exit 2 with a named refusal.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../demo-usage.mts";
import { MEASURED, MEASURED_LLM, MEASURED_ROW } from "./test-fixtures";

type Captured = { readonly code: number; readonly out: string; readonly err: string };

async function run(argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function writeRun(root: string, runId: string, calls: readonly typeof MEASURED[]): void {
  for (const call of calls) {
    const callDir = join(root, runId, "calls", call.callId);
    mkdirSync(callDir, { recursive: true });
    writeFileSync(join(callDir, "trace.jsonl"), `${JSON.stringify(call.row)}\n`, "utf8");
    writeFileSync(
      join(callDir, "call.json"),
      `${JSON.stringify({ callId: call.callId, scenario: call.scenario, locale: call.locale })}\n`,
      "utf8",
    );
  }
  writeFileSync(
    join(root, runId, "run.json"),
    `${JSON.stringify({ schemaVersion: 1, runId })}\n`,
    "utf8",
  );
}

test("prints a run ledger and exits 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-usage-cli-"));
  try {
    writeRun(root, "browser-cli", [MEASURED, MEASURED_LLM]);
    const result = await run([
      "--run",
      "browser-cli",
      "--run-root",
      root,
      "--evidence-root",
      join(root, "evidence"),
    ]);
    assert.equal(result.code, 0);
    assert.match(result.out, /demo:usage · run browser-cli/);
    assert.match(result.out, /TOTAL \$0\.00858385 across 2 calls/);
    assert.match(result.out, /PER CALL/);
    assert.match(result.out, /UNMEASURED\s+none/);
    assert.equal(result.err, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--latest prints the newest evidence set", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-usage-cli-"));
  try {
    writeRun(root, "browser-cli", [MEASURED]);
    const result = await run([
      "--latest",
      "--run-root",
      root,
      "--evidence-root",
      join(root, "evidence"),
    ]);
    assert.equal(result.code, 0);
    assert.match(result.out, /run browser-cli/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses an unknown run id with a named non-zero exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-usage-cli-"));
  try {
    const result = await run([
      "--run",
      "verify-missing",
      "--run-root",
      root,
      "--evidence-root",
      join(root, "evidence"),
    ]);
    assert.equal(result.code, 2);
    assert.match(result.err, /REFUSED \(unknown-run\)/);
    assert.match(result.err, /verify-missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a torn row with a named non-zero exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-usage-cli-"));
  try {
    const callDir = join(root, "browser-torn", "calls", MEASURED.callId);
    mkdirSync(callDir, { recursive: true });
    writeFileSync(join(callDir, "trace.jsonl"), `{"type":"cost.priced","measured":true\n`, "utf8");
    writeFileSync(
      join(callDir, "call.json"),
      `${JSON.stringify({ callId: MEASURED.callId, scenario: MEASURED.scenario })}\n`,
      "utf8",
    );
    const result = await run([
      "--run",
      "browser-torn",
      "--run-root",
      root,
      "--evidence-root",
      join(root, "evidence"),
    ]);
    assert.equal(result.code, 2);
    assert.match(result.err, /REFUSED \(torn-row\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prints usage on --help and exits 0", async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /--run <runId> \| --latest/);
});

test("refuses a missing selector with exit 2", async () => {
  const result = await run([]);
  assert.equal(result.code, 2);
  assert.match(result.err, /choose one of --run <runId> or --latest/);
});
