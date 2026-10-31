#!/usr/bin/env node
/**
 * The CI gate over a `demo:verify --json` report (ticket 30).
 *
 * `demo:verify` exits 1 for a clean fast scoped-pass and for a clean nightly
 * health report, because neither is a certificate. A merge gate needs to tell
 * "clean scoped-pass" from "not-demo-ready", so this reader checks the report's
 * status and call count and exits 0 only for the expected clean state:
 *
 *   fast      the fast contract's calls, status "scoped-pass"  (never a certificate)
 *   nightly   the nightly plan's calls, status "health-clean"  (a report, never a pass)
 *   full      the full plan's calls, status "certified" or "pending-human";
 *             a certificate must exist. pending-human prints a warning and is
 *             not a pass.
 *
 * The call counts are the cadence's one source; this reader imports them
 * instead of restating a number.
 *
 * Any refusal, not-demo-ready, ineligible, short call count or missing
 * certificate fails. The workflow's required wrapper separately fails on a
 * skipped, cancelled or artifact-less job.
 *
 *   node --import tsx scripts/demo-gate-report.mjs <fast|nightly|full> <report.json>
 */

import { readFileSync, appendFileSync } from "node:fs";

import {
  FAST_CALLS,
  FULL_CALLS,
  NIGHTLY_CALLS,
} from "../src/lib/demo/verification/cadence.ts";

// The counts are the cadence's one source; this reader never restates them.
const EXPECTED_CALLS = { fast: FAST_CALLS, nightly: NIGHTLY_CALLS, full: FULL_CALLS };
const EXPECTED_STATUS = {
  fast: ["scoped-pass"],
  nightly: ["health-clean"],
  full: ["certified", "pending-human"],
};

function fail(message) {
  console.error(`demo-gate: ${message}`);
  process.exit(1);
}

const [mode, path] = process.argv.slice(2);
if (!(mode in EXPECTED_CALLS)) {
  fail(`unknown mode ${JSON.stringify(mode)}; expected fast, nightly or full`);
}
if (path === undefined) fail("a report path is required");

let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  fail(`cannot read the report ${path}: ${error instanceof Error ? error.message : error}`);
}

const expectedCalls = EXPECTED_CALLS[mode];
if (report.mode !== mode) fail(`the report is a "${report.mode}" run, not "${mode}"`);
if (report.calls !== expectedCalls) {
  fail(`the ${mode} run made ${report.calls} calls; the plan is ${expectedCalls}`);
}
if (!EXPECTED_STATUS[mode].includes(report.status)) {
  fail(
    `the ${mode} run reports "${report.status}" (exit ${report.exitCode}); ` +
      `expected ${EXPECTED_STATUS[mode].join(" or ")}`,
  );
}
if (report.exitCode === 2 || report.status === "refused") {
  fail(`the ${mode} run refused: ${(report.refusals ?? []).join("; ")}`);
}
if (mode === "full" && !report.certificate) {
  fail("the full run produced no certificate; a panel-signed claim needs one");
}

if (report.status === "pending-human") {
  const line =
    "### Full certification: PENDING-HUMAN — not a pass\n\n" +
    "The certificate exists but the owner's panel has not signed it. " +
    "This job is evidence for the panel, never a green claim.";
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log("::warning title=demo full certification pending-human::The certificate is unsigned.");
  }
}

console.log(
  `demo-gate: ${mode} ${report.status} (${report.calls} calls, exit ${report.exitCode})`,
);
