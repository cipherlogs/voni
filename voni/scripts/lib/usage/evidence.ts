/**
 * Read one run's evidence, fail closed.
 *
 * A run id names either a local adapter directory under `voni/.demo-runs/` or a
 * committed certificate under `voni/evidence/certificates/`. A certificate
 * resolves through the call ids in its coverage rows to the per-call
 * directories, so the committed claim and the local trace are joined without
 * inventing a call. A missing run, a certificate naming absent evidence, a
 * missing `cost.priced` row and a torn row are named refusals.
 */

import type { Dirent } from "node:fs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PricedCostError, readPricedRow, type PricedCost } from "@/lib/demo/verification/economics";

import { parseTrace } from "../adapter-evidence";
import { sameUsd, sumMeasuredCalls } from "./sums";
import { UsageCliError, refuse, type UsageCall, type UsageRun } from "./types";

/** The repository root, resolved from this module (`voni/scripts/lib/usage/`). */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Where the adapters write per-call evidence. Gitignored, local. */
export const DEFAULT_RUN_ROOT = join(REPO_ROOT, "voni", ".demo-runs");

/** Where the committed certificate lives. */
export const DEFAULT_EVIDENCE_ROOT = join(REPO_ROOT, "voni", "evidence");

export type ResolveOptions = {
  readonly runRoot: string;
  readonly evidenceRoot: string;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function requireSafeRunId(runId: string): string {
  if (!SAFE_ID.test(runId) || runId.includes("..")) {
    refuse(
      "bad-input",
      `"${runId}" is not a safe run id; use letters, digits, dot, dash or underscore`,
    );
  }
  return runId;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string, what: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    refuse("missing-evidence", `${what} is missing at ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    refuse("torn-row", `${what} at ${file} is not JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) refuse("torn-row", `${what} at ${file} is not an object`);
  return parsed;
}

function optionalText(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The leg units the priced-row reader already validated, in the ledger's shape. */
function unitsOf(priced: PricedCost): Record<string, Record<string, number>> {
  const units: Record<string, Record<string, number>> = {};
  for (const leg of priced.legs) units[leg.leg] = { ...leg.units };
  return units;
}

export type UsageCallInput = {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: string | null;
  readonly tracePath: string;
  readonly row: unknown;
};

/** Read one call's priced row into the ledger's own shape. */
export function readUsageCall(input: UsageCallInput): UsageCall {
  const callId = requireSafeRunId(input.callId);
  if (input.scenario.trim() === "") {
    refuse("torn-row", `call ${callId} records no scenario; a call without one cannot be grouped`);
  }
  if (!isObject(input.row)) {
    refuse("torn-row", `call ${callId}: the cost row is not an object`);
  }
  const rowCallId = optionalText(input.row, "callId");
  if (rowCallId !== null && rowCallId !== callId) {
    refuse(
      "torn-row",
      `call ${callId}: the cost row names call ${rowCallId}; a row belongs to one call`,
    );
  }
  let priced;
  try {
    priced = readPricedRow(input.row);
  } catch (error) {
    if (error instanceof PricedCostError) {
      refuse("torn-row", `call ${callId}: ${error.code}: ${error.message}`);
    }
    throw error;
  }
  return {
    callId,
    scenario: input.scenario.trim(),
    locale: input.locale === null ? null : input.locale.trim() || null,
    priced,
    units: unitsOf(priced),
    tracePath: input.tracePath,
  };
}

function traceOf(callDir: string): string {
  return join(callDir, "trace.jsonl");
}

function callScenario(
  callDir: string,
  fallback: Record<string, unknown> | null,
): { scenario: string; locale: string | null } {
  const callFile = join(callDir, "call.json");
  const record = exists(callFile) ? readJson(callFile, "call.json") : null;
  const scenario =
    (record === null ? null : optionalText(record, "scenario")) ??
    (fallback === null ? null : optionalText(fallback, "scenario"));
  if (scenario === null) {
    refuse(
      "torn-row",
      `${callDir} records no scenario in call.json or run.json; a call without one cannot be grouped`,
    );
  }
  const locale =
    (record === null ? null : optionalText(record, "locale")) ??
    (fallback === null ? null : optionalText(fallback, "locale"));
  return { scenario, locale };
}

/** Parse one call directory's trace into a ledger call. */
function readCallDir(
  callDir: string,
  callId: string,
  scenario: string,
  locale: string | null,
): UsageCall {
  const trace = traceOf(callDir);
  let raw: string;
  try {
    raw = readFileSync(trace, "utf8");
  } catch {
    refuse("missing-evidence", `call ${callId} has no trace at ${trace}; nothing measured it`);
  }
  const rows = parseTrace(
    raw,
    trace,
    (code, message) => new UsageCliError("torn-row", `${code}: ${message}`),
  );
  const priced = rows.filter((row) => row.type === "cost.priced");
  if (priced.length === 0) {
    refuse(
      "missing-evidence",
      `call ${callId} has no cost.priced row in ${trace}; an unpriced call has no usage`,
    );
  }
  if (priced.length > 1) {
    refuse(
      "torn-row",
      `call ${callId} has ${priced.length} cost.priced rows in ${trace}; one call has one price`,
    );
  }
  return readUsageCall({
    callId,
    scenario,
    locale,
    tracePath: trace,
    row: priced[0] as unknown,
  });
}

function callDirsOf(runDir: string): string[] {
  const callsDir = join(runDir, "calls");
  let entries;
  try {
    entries = readdirSync(callsDir, { withFileTypes: true });
  } catch {
    // A direct call directory (a call id that was also the run id) is accepted
    // only when it carries its own trace.
    if (exists(traceOf(runDir))) return [runDir];
    refuse("missing-evidence", `${runDir} has no calls directory; a run directory holds calls/`);
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(callsDir, entry.name))
    .filter((dir) => exists(traceOf(dir)))
    .sort();
  if (dirs.length === 0) {
    refuse("missing-evidence", `${callsDir} holds no call with a trace; the run measured nothing`);
  }
  return dirs;
}

function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Count call traces without refusing on an empty run; readiness names it. */
function countCallTraces(runDir: string): number {
  if (exists(traceOf(runDir))) return 1;
  try {
    return readdirSync(join(runDir, "calls"), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && exists(traceOf(join(runDir, "calls", entry.name))),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * A run directory is readable only after the adapter wrote a terminal
 * `run.json`. Mid-run, the directory holds one call's trace and no endedAt, so
 * refusing here stops a fragment printing as a complete run.
 */
function terminalRunRecord(runDir: string, callsSeen: number): Record<string, unknown> {
  const runFile = join(runDir, "run.json");
  const seen = `${callsSeen} call trace${callsSeen === 1 ? "" : "s"} seen`;
  if (!exists(runFile)) {
    refuse(
      "incomplete-run",
      `${runDir} has no run.json; the adapter writes it only when the run ends (${seen})`,
    );
  }
  const record = readJson(runFile, "run.json");
  const endedAt = optionalText(record, "endedAt");
  const status = optionalText(record, "status");
  if (endedAt === null || status === null) {
    refuse(
      "incomplete-run",
      `${runFile} has no terminal endedAt/status; a run is readable only after it ends (${seen})`,
    );
  }
  return record;
}

function directoryRun(runId: string, runRoot: string): UsageRun | null {
  const runDir = resolve(runRoot, runId);
  if (!exists(runDir)) return null;
  if (!statSync(runDir).isDirectory()) {
    refuse("missing-evidence", `${runDir} is not a run directory`);
  }
  // The adapter writes one call per run directory. Readiness is proved by the
  // terminal run.json, never by "a trace exists".
  const runRecord = terminalRunRecord(runDir, countCallTraces(runDir));
  const dirs = callDirsOf(runDir);
  if (dirs.length !== 1) {
    refuse(
      "torn-row",
      `${runDir} holds ${dirs.length} calls; one adapter run directory holds exactly one call`,
    );
  }
  const calls = dirs.map((callDir) => {
    const callId = callDir === runDir ? runId : basename(callDir);
    const { scenario, locale } = callScenario(callDir, runRecord);
    return readCallDir(callDir, callId, scenario, locale);
  });
  return {
    runId,
    kind: "directory",
    calls,
    expectedCalls: 1,
    source: runDir,
  };
}

type CertificateCall = {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: string | null;
};

type CertificateCoverage = {
  readonly calls: readonly CertificateCall[];
  /** The plan's calls: the sum of every coverage row's required repetitions. */
  readonly expectedCalls: number;
};

/** Every call id a certificate's coverage rows name, in row order. */
function certificateCalls(certificate: Record<string, unknown>, runId: string): CertificateCoverage {
  const cost = certificate.cost;
  if (!isObject(cost)) refuse("torn-row", `certificate ${runId} has no cost object`);
  const callCount = cost.callCount;
  if (typeof callCount !== "number" || !Number.isInteger(callCount) || callCount < 0) {
    refuse("torn-row", `certificate ${runId} cost.callCount is not a non-negative integer`);
  }
  // v4 records a measured lower bound; a pre-v4 document recorded an exact
  // total under `usd`. Both reconcile against the same measured legs.
  const certificateUsd = cost.usdMeasured ?? cost.usd;
  if (typeof certificateUsd !== "number" || !Number.isFinite(certificateUsd) || certificateUsd < 0) {
    refuse(
      "torn-row",
      `certificate ${runId} cost.usdMeasured is not a finite, non-negative amount`,
    );
  }
  const coverage = certificate.coverage;
  if (!isObject(coverage)) refuse("torn-row", `certificate ${runId} has no coverage object`);
  const rows = coverage.rows;
  if (!Array.isArray(rows)) refuse("torn-row", `certificate ${runId} has no coverage rows`);

  const byCall = new Map<string, CertificateCall>();
  let expectedCalls = 0;
  for (const rawRow of rows) {
    if (!isObject(rawRow)) refuse("torn-row", `certificate ${runId} has a non-object coverage row`);
    const scenario = optionalText(rawRow, "scenario");
    if (scenario === null) {
      refuse("torn-row", `certificate ${runId} has a coverage row without a scenario`);
    }
    const required = rawRow.requiredRepetitions;
    if (typeof required !== "number" || !Number.isInteger(required) || required < 1) {
      refuse(
        "torn-row",
        `certificate ${runId} coverage row "${scenario}" has no positive integer requiredRepetitions`,
      );
    }
    expectedCalls += required;
    const locale = optionalText(rawRow, "locale");
    const calls = rawRow.calls;
    if (!Array.isArray(calls)) {
      refuse("torn-row", `certificate ${runId} coverage row "${scenario}" has no calls list`);
    }
    for (const rawCallId of calls) {
      if (typeof rawCallId !== "string" || rawCallId.trim() === "") {
        refuse("torn-row", `certificate ${runId} coverage row "${scenario}" has a blank call id`);
      }
      const rawId = rawCallId.trim();
      if (!SAFE_ID.test(rawId) || rawId.includes("..")) {
        refuse(
          "torn-row",
          `certificate ${runId} names call "${rawId}", which is not a call directory name; ` +
            "the certificate and the local trace cannot be joined",
        );
      }
      const callId = rawId;
      const previous = byCall.get(callId);
      if (previous !== undefined) {
        refuse(
          "torn-row",
          `certificate ${runId} names call ${callId} twice ` +
            `(${previous.scenario} and ${scenario}); one call is measured once`,
        );
      }
      byCall.set(callId, { callId, scenario, locale });
    }
  }
  if (callCount !== byCall.size) {
    refuse(
      "torn-row",
      `certificate ${runId} claims ${callCount} calls but its coverage names ${byCall.size}; ` +
        "the ledger will not reconcile a count it cannot find",
    );
  }
  if (byCall.size === 0) {
    refuse("missing-evidence", `certificate ${runId} names no calls; there is no usage to read`);
  }
  if (byCall.size > expectedCalls) {
    refuse(
      "torn-row",
      `certificate ${runId} names ${byCall.size} calls but its coverage plans ${expectedCalls}; ` +
        "a run cannot measure more calls than it planned",
    );
  }
  return { calls: [...byCall.values()], expectedCalls };
}

/** Index every call directory under the run root by its call id. */
function callIndex(runRoot: string): Map<string, string> {
  const index = new Map<string, string>();
  let entries;
  try {
    entries = readdirSync(runRoot, { withFileTypes: true });
  } catch {
    refuse("missing-evidence", `the run root ${runRoot} does not exist`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const callsDir = join(runRoot, entry.name, "calls");
    let callEntries;
    try {
      callEntries = readdirSync(callsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const callEntry of callEntries) {
      if (!callEntry.isDirectory()) continue;
      const dir = join(callsDir, callEntry.name);
      // A duplicate call id would make a dashboard line ambiguous.
      if (index.has(callEntry.name)) {
        refuse(
          "torn-row",
          `call ${callEntry.name} appears in more than one run directory ` +
            `(${index.get(callEntry.name)} and ${dir}); a call is measured once`,
        );
      }
      index.set(callEntry.name, dir);
    }
  }
  return index;
}

function certificateRun(
  runId: string,
  options: ResolveOptions,
): UsageRun | null {
  const file = join(options.evidenceRoot, "certificates", `${runId}.json`);
  if (!exists(file)) return null;
  const certificate = readJson(file, `certificate ${runId}`);
  const certificateRunId = optionalText(certificate, "runId");
  if (certificateRunId !== runId) {
    refuse(
      "torn-row",
      `certificate at ${file} names run ${JSON.stringify(certificateRunId)}; the file name is ${runId}`,
    );
  }
  const coverage = certificateCalls(certificate, runId);
  const index = callIndex(options.runRoot);
  const resolved = coverage.calls.map((entry) => {
    const callDir = index.get(entry.callId);
    if (callDir === undefined) {
      refuse(
        "missing-evidence",
        `certificate ${runId} names call ${entry.callId}, but no directory under ` +
          `${options.runRoot} holds it; the committed claim and the local trace cannot be joined`,
      );
    }
    // The certificate's coverage row is a claim about this call. If the local
    // call.json names a different scenario or Locale, the join would relabel
    // the evidence; refuse instead.
    const local = callScenario(callDir, {
      scenario: entry.scenario,
      ...(entry.locale === null ? {} : { locale: entry.locale }),
    });
    if (local.scenario !== entry.scenario) {
      refuse(
        "torn-row",
        `certificate ${runId} names call ${entry.callId} as scenario "${entry.scenario}", ` +
          `but its call.json says "${local.scenario}"; the join would relabel the evidence`,
      );
    }
    if (entry.locale !== null && local.locale !== null && local.locale !== entry.locale) {
      refuse(
        "torn-row",
        `certificate ${runId} names call ${entry.callId} as Locale "${entry.locale}", ` +
          `but its call.json says "${local.locale}"; the join would relabel the evidence`,
      );
    }
    return readCallDir(callDir, entry.callId, entry.scenario, entry.locale ?? local.locale);
  });
  const cost = certificate.cost as Record<string, unknown>;
  const certificateUsd = (cost.usdMeasured ?? cost.usd) as number;
  const measuredUsd = sumMeasuredCalls(resolved);
  if (!sameUsd(certificateUsd, measuredUsd)) {
    refuse(
      "torn-row",
      `certificate ${runId} claims $${certificateUsd.toFixed(6)} measured but its priced rows sum to ` +
        `$${measuredUsd.toFixed(6)}; the committed claim and the local trace disagree`,
    );
  }
  return {
    runId,
    kind: "certificate",
    calls: resolved,
    expectedCalls: coverage.expectedCalls,
    source: file,
  };
}

/** Resolve exactly the run id asked for; an unknown id is a refusal. */
export function resolveRun(runId: string, options: ResolveOptions): UsageRun {
  requireSafeRunId(runId);
  const directory = directoryRun(runId, options.runRoot);
  if (directory !== null) return directory;
  const certificate = certificateRun(runId, options);
  if (certificate !== null) return certificate;
  refuse(
    "unknown-run",
    `no run "${runId}" under ${options.runRoot} or ${join(options.evidenceRoot, "certificates")}`,
  );
}

type Candidate = {
  readonly runId: string;
  readonly mtimeMs: number;
  readonly kind: "directory" | "certificate";
};

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/**
 * A directory is a latest candidate as soon as it exists with a `run.json` or
 * a `calls/` directory. An in-progress directory must be selected and then
 * refused as incomplete, never skipped for an older completed run.
 */
function hasRunEvidence(runDir: string): boolean {
  return exists(join(runDir, "run.json")) || exists(join(runDir, "calls")) || exists(traceOf(runDir));
}

function candidates(options: ResolveOptions): Candidate[] {
  const found: Candidate[] = [];
  let runEntries: Dirent[];
  try {
    runEntries = readdirSync(options.runRoot, { withFileTypes: true });
  } catch {
    runEntries = [];
  }
  for (const entry of runEntries) {
    if (!entry.isDirectory()) continue;
    const dir = join(options.runRoot, entry.name);
    if (!hasRunEvidence(dir)) continue;
    found.push({
      runId: entry.name,
      mtimeMs: Math.max(mtimeOf(join(dir, "run.json")), mtimeOf(dir)),
      kind: "directory",
    });
  }
  let certEntries: Dirent[];
  try {
    certEntries = readdirSync(join(options.evidenceRoot, "certificates"), {
      withFileTypes: true,
    });
  } catch {
    certEntries = [];
  }
  for (const entry of certEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    found.push({
      runId: entry.name.slice(0, -".json".length),
      mtimeMs: mtimeOf(join(options.evidenceRoot, "certificates", entry.name)),
      kind: "certificate",
    });
  }
  return found;
}

/**
 * The newest readable evidence set. A newer certificate wins over an older
 * adapter directory; an in-progress newest directory is refused as incomplete,
 * never skipped for an older clean one.
 */
export function resolveLatest(options: ResolveOptions): UsageRun {
  const found = candidates(options).sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    if (a.kind !== b.kind) return a.kind === "certificate" ? -1 : 1;
    return a.runId.localeCompare(b.runId);
  });
  const newest = found[0];
  if (newest === undefined) {
    refuse(
      "missing-evidence",
      `no run evidence under ${options.runRoot} or ${join(options.evidenceRoot, "certificates")}`,
    );
  }
  return resolveRun(newest.runId, options);
}

/**
 * The run-journal seam. The next change feeds this tool an append-only JSONL
 * journal instead of `--latest`'s mtime guess; the interface is written down in
 * `run-journal.md` beside this file. It is deliberately not implemented on this
 * branch (the resume branch lands first), and it refuses by name rather than
 * falling back to mtime.
 */
export function readRunJournal(_runId: string, _journalRoot: string): never {
  refuse(
    "run-journal-not-implemented",
    "the append-only run journal reader lands after the resume branch merges; this branch reads " +
      "a terminal run directory or a committed certificate only",
  );
}
