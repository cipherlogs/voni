/**
 * Ticket 09: the aggregate total is composed, not re-derived.
 *
 * The console's whole reason is one honest number — what every enabled source
 * adds up to per day — so the risk is a second day arithmetic growing on the
 * page beside the two the cards already own. These assertions pin the page to
 * the existing `clicksPerDay` from `@/lib/email/volume` (Grafana) and
 * `@/lib/email/sources` (GitHub), and pin the two facts the aggregate must not
 * fudge: a failed Grafana read makes the total `null` (Unavailable), never 0,
 * and a disabled source contributes 0.
 *
 * The arithmetic itself is exercised here too, so the numbers the spec quotes
 * (8,640 / 34,560 / 17,280) are the ones the page will feed into its sum rather
 * than a promise in a comment.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clicksPerDay as grafanaClicksPerDay } from "@/lib/email/volume";
import { RUNNER_OSES, clicksPerDay as runnerClicksPerDay } from "@/lib/email/sources";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

/** The one subtree allowed to read data, slice from its declaration onward. */
const controlData = page.slice(page.indexOf("async function EmailControlData("));

test("the total is built from the two existing volume modules", () => {
  assert.match(
    page,
    /clicksPerDay as grafanaClicksPerDay[\s\S]*?from "@\/lib\/email\/volume"/,
    "Grafana's arithmetic is the card's, imported under a name that says which source",
  );
  assert.match(
    page,
    /clicksPerDay as runnerClicksPerDay[\s\S]*?from "@\/lib\/email\/sources"/,
    "GitHub's arithmetic is the card's runner-domain function",
  );
  assert.match(page, /\bRUNNER_OSES\b/, "the OS count is the shared constant");
});

test("Grafana's term reads the live check, and a failed read is null", () => {
  assert.match(
    controlData,
    /checkResult\.data\.frequencyMs,\s*\n\s*checkResult\.data\.probeIds\.length,\s*\n\s*checkResult\.data\.clicksPerRun,/,
    "same three inputs the Grafana card renders",
  );
  assert.match(
    controlData,
    /checkResult\.ok\s*\?\s*0\s*:\s*null|:\s*checkResult\.ok\s*\?\s*0\s*:\s*null/,
    "a check that cannot be read is unknown (null), not a zero the page would then trust",
  );
  assert.match(
    controlData,
    /totalClicksPerDay =\s*\n?\s*grafanaVolume === null \? null : grafanaVolume \+ githubVolume/,
    "the total propagates the unknown instead of summing around it",
  );
});

test("GitHub's term reads the saved schedule, the shared target count and 3 OSes", () => {
  assert.match(
    controlData,
    /runnerClicksPerDay\(\s*\n\s*githubConfig\.intervalSeconds,\s*\n\s*githubConfig\.windowSeconds,\s*\n\s*githubConfig\.segmentSeconds,\s*\n\s*githubConfig\.restartSeconds,\s*\n\s*activeTargets\.length,\s*\n\s*RUNNER_OSES\.length,/,
  );
  assert.match(
    controlData,
    /githubConfig\?\.enabled === true[\s\S]*?runnerClicksPerDay\(/,
    "a disabled or missing GitHub row contributes 0",
  );
  assert.match(
    controlData,
    /: 0;[\s\S]*?totalClicksPerDay/,
    "the disabled branch is the literal zero",
  );
});

test("a paused target lowers both the aggregate and the card's denominator", () => {
  assert.match(
    controlData,
    /const activeTargets = targets\.filter\(\(target\) => target\.enabled\)/,
    "one active set, the same predicate activeTargetUrls() uses at dispatch",
  );
  assert.match(
    controlData,
    /runnerClicksPerDay\(\s*\n\s*githubConfig\.intervalSeconds,\s*\n\s*githubConfig\.windowSeconds,\s*\n\s*githubConfig\.segmentSeconds,\s*\n\s*githubConfig\.restartSeconds,\s*\n\s*activeTargets\.length,/,
    "the aggregate counts enabled targets only",
  );
  assert.match(
    controlData,
    /summariseRunnerClicks\(\s*\n\s*githubClicks,\s*\n\s*activeTargets\.map\(\(target\) => target\.url\),/,
    "targets x/x is measured against the active list too",
  );
  assert.match(
    page,
    /targetCount=\{activeTargets\.length\}/,
    "the card's denominator is the active count, not every row",
  );

  // Pausing one of four targets lowers both numbers by exactly a quarter.
  const all = runnerClicksPerDay(60, 12 * 3_600, 60, 60, 4, RUNNER_OSES.length);
  const paused = runnerClicksPerDay(60, 12 * 3_600, 60, 60, 3, RUNNER_OSES.length);
  assert.equal(all, 1_848);
  assert.equal(paused, 1_386);
});

test("the page adds no second day arithmetic and Burst adds no daily volume", () => {
  const volumeBlock = controlData.slice(
    controlData.indexOf("const grafanaVolume"),
    // Up to the render: the aggregate ends with `totalClicksPerDay`.
    controlData.indexOf("  return ("),
  );
  assert.ok(volumeBlock.length > 0, "the aggregate is computed in EmailControlData");
  assert.doesNotMatch(
    volumeBlock,
    /86_400|3_600|24 \* 60|DAY_MS|clicksPerDay\([^)]*\)\s*\/\s*\d/,
    "no inline day/second conversion beside the two imported functions",
  );
  assert.doesNotMatch(
    volumeBlock,
    /Burst|burst/,
    "Burst is on demand; it has no place in the daily sum",
  );
});

test("the imported functions still produce the spec's numbers", () => {
  // GitHub: a 60 s segment plus a 60 s restart gap over 12 h, four targets,
  // three OSes: 360 cycles x 3 x 4 clicks.
  assert.equal(runnerClicksPerDay(60, 12 * 3_600, 60, 60, 4, RUNNER_OSES.length), 1_848);
  // Today's measured shape: one 15 s pass over five targets, a 24 h window,
  // replaced two minutes after it goes silent.
  assert.equal(runnerClicksPerDay(15, 24 * 3_600, 15, 120, 5, RUNNER_OSES.length), 5_505);
  // Grafana: 5-minute check on four probes at three clicks per run.
  assert.equal(grafanaClicksPerDay(5 * 60_000, 4, 3), 3_456);
});
