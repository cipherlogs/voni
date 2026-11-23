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
    /runnerClicksPerDay\(\s*\n\s*githubConfig\.intervalSeconds,\s*\n\s*githubConfig\.windowSeconds,\s*\n\s*targets\.length,\s*\n\s*RUNNER_OSES\.length,/,
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

test("the page adds no second day arithmetic and Burst adds no daily volume", () => {
  const volumeBlock = controlData.slice(
    controlData.indexOf("const grafanaVolume"),
    controlData.indexOf("const notice ="),
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
  // GitHub: 60 s over 12 h, four targets, three OSes.
  assert.equal(runnerClicksPerDay(60, 12 * 3_600, 4, RUNNER_OSES.length), 8_640);
  // The 15 s floor over the same window.
  assert.equal(runnerClicksPerDay(15, 12 * 3_600, 4, RUNNER_OSES.length), 34_560);
  // A 24 h window at 60 s.
  assert.equal(runnerClicksPerDay(60, 24 * 3_600, 4, RUNNER_OSES.length), 17_280);
  // Grafana: 5-minute check on four probes at three clicks per run.
  assert.equal(grafanaClicksPerDay(5 * 60_000, 4, 3), 3_456);
});
