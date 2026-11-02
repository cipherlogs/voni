/**
 * Run-id resolution and the fail-closed evidence reader.
 *
 * A run id may name a local adapter directory or a committed certificate. A
 * certificate resolves through the call ids in its coverage rows to the
 * per-call directories under `.demo-runs`. A missing run, a missing priced row,
 * a torn row and a certificate whose call count disagrees with the evidence are
 * named refusals, never a partial ledger.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageCliError } from "./types";
import { resolveLatest, resolveRun } from "./evidence";
import {
  MEASURED,
  MEASURED_LLM,
  MEASURED_ROW,
  UNMEASURED,
  UNMEASURED_ROW,
  ZERO,
} from "./test-fixtures";

type Fixture = {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: string;
  readonly row: unknown;
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dv-usage-"));
}

function writeCall(
  root: string,
  runId: string,
  fixture: Fixture,
  options: { readonly trace?: string; readonly pricedRows?: readonly unknown[] } = {},
): string {
  const callDir = join(root, runId, "calls", fixture.callId);
  mkdirSync(callDir, { recursive: true });
  const rows = options.pricedRows ?? [fixture.row];
  const trace =
    options.trace ?? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(join(callDir, "trace.jsonl"), trace, "utf8");
  writeFileSync(
    join(callDir, "call.json"),
    `${JSON.stringify(
      { callId: fixture.callId, scenario: fixture.scenario, locale: fixture.locale },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return callDir;
}

function writeRun(root: string, runId: string, fixtures: readonly Fixture[]): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        scenario: fixtures[0]?.scenario ?? "unknown",
        locale: fixtures[0]?.locale ?? "en",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  for (const fixture of fixtures) writeCall(root, runId, fixture);
  return dir;
}

function writeCertificate(
  evidenceRoot: string,
  runId: string,
  rows: readonly { readonly scenario: string; readonly locale: string; readonly calls: readonly string[] }[],
  callCount: number,
): string {
  const dir = join(evidenceRoot, "certificates");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        cost: { usd: 0, callCount },
        coverage: {
          rows: rows.map((row) => ({
            locale: row.locale,
            scenario: row.scenario,
            heldOut: false,
            requiredRepetitions: 1,
            measuredRepetitions: row.calls.length,
            status: "measured",
            gap: null,
            calls: row.calls,
          })),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return file;
}

function refusalCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof UsageCliError, `expected a usage refusal, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected a refusal, but the call returned");
}

test("resolves a certificate run id through its coverage call ids", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    const evidenceRoot = join(root, "evidence");
    // The certificate names two calls that live in two different adapter runs.
    writeRun(runRoot, "browser-aaa", [MEASURED]);
    writeRun(runRoot, "browser-bbb", [MEASURED_LLM]);
    writeCertificate(
      evidenceRoot,
      "verify-20261102-01",
      [
        { scenario: MEASURED.scenario, locale: "en", calls: [MEASURED.callId] },
        { scenario: MEASURED_LLM.scenario, locale: "en", calls: [MEASURED_LLM.callId] },
      ],
      2,
    );

    const run = resolveRun("verify-20261102-01", { runRoot, evidenceRoot });
    assert.equal(run.kind, "certificate");
    assert.equal(run.expectedCalls, 2);
    assert.equal(run.calls.length, 2);
    assert.deepEqual(
      run.calls.map((call) => call.callId).sort(),
      [MEASURED.callId, MEASURED_LLM.callId].sort(),
    );
    assert.equal(run.calls.find((call) => call.callId === MEASURED_LLM.callId)?.scenario, "golden-flow-booking");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves a local adapter run directory", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    writeRun(runRoot, "browser-local", [MEASURED, ZERO]);
    const run = resolveRun("browser-local", { runRoot, evidenceRoot: join(root, "evidence") });
    assert.equal(run.kind, "directory");
    assert.equal(run.calls.length, 2);
    assert.equal(run.expectedCalls, 2);
    assert.equal(
      run.calls.find((call) => call.callId === MEASURED.callId)?.scenario,
      MEASURED.scenario,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--latest picks the newest readable run directory", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    const older = writeRun(runRoot, "browser-old", [MEASURED]);
    const newer = writeRun(runRoot, "browser-new", [MEASURED_LLM]);
    const old = new Date("2026-11-01T10:00:00Z");
    const fresh = new Date("2026-11-02T10:00:00Z");
    utimesSync(join(older, "run.json"), old, old);
    utimesSync(older, old, old);
    utimesSync(join(newer, "run.json"), fresh, fresh);
    utimesSync(newer, fresh, fresh);

    const run = resolveLatest({ runRoot, evidenceRoot: join(root, "evidence") });
    assert.equal(run.runId, "browser-new");
    assert.equal(run.calls[0]?.callId, MEASURED_LLM.callId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--latest prefers a newer certificate over an older adapter run", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    const evidenceRoot = join(root, "evidence");
    const dir = writeRun(runRoot, "browser-old", [MEASURED]);
    const cert = writeCertificate(
      evidenceRoot,
      "verify-20261102-02",
      [{ scenario: MEASURED.scenario, locale: "en", calls: [MEASURED.callId] }],
      1,
    );
    const old = new Date("2026-11-01T10:00:00Z");
    const fresh = new Date("2026-11-02T10:00:00Z");
    utimesSync(join(dir, "run.json"), old, old);
    utimesSync(dir, old, old);
    utimesSync(cert, fresh, fresh);

    const run = resolveLatest({ runRoot, evidenceRoot });
    assert.equal(run.runId, "verify-20261102-02");
    assert.equal(run.kind, "certificate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses an unknown run id by name", () => {
  const root = tempRoot();
  try {
    const code = refusalCode(() =>
      resolveRun("verify-missing", { runRoot: join(root, ".demo-runs"), evidenceRoot: join(root, "evidence") }),
    );
    assert.equal(code, "unknown-run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a run with no priced row", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    const runId = "browser-nocost";
    const callDir = join(runRoot, runId, "calls", MEASURED.callId);
    mkdirSync(callDir, { recursive: true });
    writeFileSync(join(callDir, "trace.jsonl"), `${JSON.stringify({ type: "greeting.done" })}\n`, "utf8");
    writeFileSync(
      join(callDir, "call.json"),
      `${JSON.stringify({ callId: MEASURED.callId, scenario: MEASURED.scenario })}\n`,
      "utf8",
    );
    const code = refusalCode(() =>
      resolveRun(runId, { runRoot, evidenceRoot: join(root, "evidence") }),
    );
    assert.equal(code, "missing-evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a torn cost row instead of skipping it", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    const runId = "browser-torn";
    const callDir = join(runRoot, runId, "calls", MEASURED.callId);
    mkdirSync(callDir, { recursive: true });
    // A partial write: the type is visible, the JSON is not.
    writeFileSync(
      join(callDir, "trace.jsonl"),
      `{"type":"cost.priced","measured":true,"totalUsd":0.00\n`,
      "utf8",
    );
    writeFileSync(
      join(callDir, "call.json"),
      `${JSON.stringify({ callId: MEASURED.callId, scenario: MEASURED.scenario })}\n`,
      "utf8",
    );
    const code = refusalCode(() =>
      resolveRun(runId, { runRoot, evidenceRoot: join(root, "evidence") }),
    );
    assert.equal(code, "torn-row");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses two priced rows for one call", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    const runId = "browser-duplicate";
    writeCall(runRoot, runId, MEASURED, { pricedRows: [MEASURED_ROW, MEASURED_ROW] });
    const code = refusalCode(() =>
      resolveRun(runId, { runRoot, evidenceRoot: join(root, "evidence") }),
    );
    assert.equal(code, "torn-row");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a certificate whose call count disagrees with the resolved calls", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    const evidenceRoot = join(root, "evidence");
    writeRun(runRoot, "browser-count", [MEASURED]);
    writeCertificate(
      evidenceRoot,
      "verify-count",
      [{ scenario: MEASURED.scenario, locale: "en", calls: [MEASURED.callId] }],
      2,
    );
    const code = refusalCode(() => resolveRun("verify-count", { runRoot, evidenceRoot }));
    assert.equal(code, "torn-row");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a certificate that names a call absent from local evidence", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    const evidenceRoot = join(root, "evidence");
    writeCertificate(
      evidenceRoot,
      "verify-absent",
      [{ scenario: UNMEASURED.scenario, locale: "en", calls: [UNMEASURED.callId] }],
      1,
    );
    const code = refusalCode(() => resolveRun("verify-absent", { runRoot, evidenceRoot }));
    assert.equal(code, "missing-evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not dress an unmeasured row's missing total as zero", () => {
  const root = tempRoot();
  try {
    const runRoot = join(root, ".demo-runs");
    writeRun(runRoot, "browser-unmeasured", [UNMEASURED]);
    const run = resolveRun("browser-unmeasured", {
      runRoot,
      evidenceRoot: join(root, "evidence"),
    });
    assert.equal(run.calls[0]?.priced.measured, false);
    assert.equal(run.calls[0]?.priced.totalUsd, null);
    // The unmeasured row still carries its measured llm amount, never a zero.
    assert.equal(run.calls[0]?.units.llm?.prompt_tokens, 4859);
    assert.equal(run.calls[0]?.units.stt?.audio_seconds, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a missing run root rather than returning an empty run", () => {
  const root = tempRoot();
  try {
    const code = refusalCode(() =>
      resolveLatest({ runRoot: join(root, "absent"), evidenceRoot: join(root, "evidence") }),
    );
    assert.equal(code, "missing-evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
