import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENGLISH_SCENARIOS,
  FAST_CALLS,
  FULL_CALLS,
  LOCALE_COUNT,
  LOCALE_CORE_SCENARIOS,
  NIGHTLY_CALLS,
  NIGHTLY_CRON,
  WEEKLY_FULL_CRON,
} from "../src/lib/demo/verification/cadence";
import { MONTHLY_PRODUCTION_CRON } from "../src/lib/demo/verification/release";

/**
 * Ticket 30's CI cadence is part of the contract, so it is tested as code.
 *
 * These tests parse the committed workflows and fail by name when a job, its
 * required wrapper, its schedule, its artifact or its timeout goes missing.
 * They also forbid path filters, literal vendor keys and a workflow that would
 * commit audio/event evidence. The call counts are the one source in
 * `src/lib/demo/verification/cadence.ts`; the gate reader is checked against
 * them, so a hand-edited workflow or reader fails here.
 *
 * A vendor "key" means a literal credential. A `${{ secrets.* }}` or
 * `${{ vars.* }}` reference is how a workflow receives one, and is allowed.
 */

const REPO = resolve(fileURLToPath(import.meta.url), "../../..");

function read(name: string): string {
  return readFileSync(resolve(REPO, ".github/workflows", name), "utf8");
}

const CI = read("ci.yml");
const NIGHTLY = read("nightly.yml");
const WEEKLY = read("demo-weekly.yml");
const MONTHLY = read("demo-monthly.yml");

/** Every job in the `jobs:` section, name to body. */
function jobs(text: string): Map<string, string> {
  const marker = "\njobs:\n";
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, "the workflow has a jobs section");
  const section = text.slice(start + marker.length);
  const matches = [...section.matchAll(/^ {2}([a-z0-9-]+):$/gm)];
  const result = new Map<string, string>();
  matches.forEach((match, index) => {
    const from = (match.index ?? 0) + match[0].length;
    const to = index + 1 < matches.length ? matches[index + 1].index : section.length;
    result.set(match[1], section.slice(from, to));
  });
  return result;
}

function job(file: string, name: string): string {
  const body = jobs(file).get(name);
  assert.ok(body !== undefined, `${name} job is missing`);
  return body;
}

/** One named step inside a job body, from `- name:` to the next step. */
function step(body: string, name: string): string | null {
  const marker = `      - name: ${name}\n`;
  const from = body.indexOf(marker);
  if (from === -1) return null;
  const rest = body.slice(from + marker.length);
  const next = rest.search(/^ {6}- (?:name|uses):/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function scheduler(text: string): string {
  const start = text.indexOf("\non:\n");
  const end = text.indexOf("\njobs:\n");
  return text.slice(start, end);
}

const RUN_JOBS = [
  ["demo-fast-contract", CI, "--fast"],
  ["demo-nightly-health", NIGHTLY, "--nightly"],
  ["demo-weekly-full", WEEKLY, "--full"],
] as const;

const WRAPPERS = [
  ["demo-fast-contract", "required-demo-fast-contract", CI],
  ["demo-nightly-health", "required-demo-nightly-health", NIGHTLY],
  ["demo-weekly-full", "required-demo-weekly-full", WEEKLY],
  ["demo-monthly-production", "required-demo-monthly-production", MONTHLY],
] as const;

test("every scheduled cadence carries the one source cron", () => {
  assert.ok(scheduler(NIGHTLY).includes(`- cron: "${NIGHTLY_CRON}"`), "nightly cron");
  assert.ok(scheduler(WEEKLY).includes(`- cron: "${WEEKLY_FULL_CRON}"`), "weekly cron");
  assert.ok(
    scheduler(MONTHLY).includes(`- cron: "${MONTHLY_PRODUCTION_CRON}"`),
    "monthly cron must equal MONTHLY_PRODUCTION_CRON",
  );
  assert.doesNotMatch(scheduler(CI), /schedule:/, "the PR workflow has no schedule");
});

test("the fast contract runs on every PR with no path filter and as a merge gate", () => {
  assert.match(CI, /\n {2}pull_request:\n/);
  assert.doesNotMatch(CI, /^\s+paths:/m, "no path filter may narrow the merge gate");
  const fast = job(CI, "demo-fast-contract");
  // Policy A: the job is gated on the key-presence output, so without keys no
  // call is even attempted. The wrapper below names the skip; it is never a
  // silent green.
  assert.match(
    fast,
    /^ {4}if: needs\.demo-fast-keys\.outputs\.present == 'true'$/m,
    "the fast job runs only when the key gate reports the keys",
  );
  assert.match(fast, /demo:verify -- --fast/);
  assert.match(fast, /demo-gate-report\.mjs fast/);
});

test("every report capture runs npm with --silent, so the report is pure JSON", () => {
  for (const [file, text] of [
    ["ci.yml", CI],
    ["nightly.yml", NIGHTLY],
    ["demo-weekly.yml", WEEKLY],
    ["demo-monthly.yml", MONTHLY],
  ] as const) {
    const captures = text
      .split("\n")
      .filter((line) => line.includes("$RUNNER_TEMP/") && line.includes("demo:verify"));
    assert.equal(captures.length, 1, `${file} captures exactly one demo:verify report`);
    for (const line of captures) {
      // `npm run` writes its own script banner to stdout; capturing it makes the
      // report unparsable. `--silent` keeps stdout the script's JSON only.
      assert.match(
        line,
        /npm run --silent demo:verify -- /,
        `${file} captures npm's script banner into the report: ${line.trim()}`,
      );
    }
  }

  // The reader stays strict: it parses the file as-is. A prefix is never
  // stripped and a missing report is never defaulted to a pass.
  const reader = readFileSync(resolve(REPO, "voni/scripts/demo-gate-report.mjs"), "utf8");
  assert.match(reader, /JSON\.parse\(readFileSync\(path, "utf8"\)\)/);
});

test("the fast wrapper passes on a named key skip and still fails a keyed run", () => {
  const keys = job(CI, "demo-fast-keys");
  assert.match(keys, /timeout-minutes:/, "the key gate needs a hang guard");
  assert.match(keys, /^ {4}outputs:$/m);
  assert.match(keys, /present: \$\{\{ steps\.keys\.outputs\.present \}\}/);
  for (const key of [
    "META_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "VOICE_PIPELINE_ENVELOPE_SECRET",
  ]) {
    assert.match(
      keys,
      new RegExp(`${key}: \\$\\{\\{ secrets\\.${key} \\}\\}`),
      `the key gate reads ${key}`,
    );
  }

  const gate = job(CI, "required-demo-fast-contract");
  assert.match(gate, /needs: \[demo-fast-keys, demo-fast-contract\]/);

  // A broken key gate is red, not a skip.
  const broken = step(gate, "the key gate must have run");
  assert.ok(broken !== null, "the wrapper fails a failed key gate");
  assert.match(broken, /if: needs\.demo-fast-keys\.result != 'success'/);
  assert.match(broken, /exit 1/);

  // The skip branch passes the required check, but it names itself in the log,
  // the step summary and an annotation.
  const skip = step(gate, "no vendor keys is a named skip, never a contract claim");
  assert.ok(skip !== null, "the wrapper has a no-keys step");
  assert.match(
    skip,
    /if: needs\.demo-fast-keys\.result == 'success' && needs\.demo-fast-keys\.outputs\.present != 'true'/,
  );
  assert.match(skip, /SKIPPED: the demo fast contract made no call/);
  assert.match(skip, /GITHUB_STEP_SUMMARY/, "the skip is written to the step summary");
  assert.match(skip, /::warning /, "the skip is an annotation, not a silent green");
  assert.doesNotMatch(skip, /exit 1/, "the named skip passes the required check");

  // The keyed branch still fails a failed, cancelled or artifact-less run.
  const keyed = step(gate, "keys present — the fast job must have succeeded");
  assert.ok(keyed !== null, "the wrapper fails a keyed run");
  assert.match(keyed, /if: needs\.demo-fast-keys\.outputs\.present == 'true'/);
  assert.match(
    keyed,
    /test "\$\{\{ needs\.demo-fast-contract\.result \}\}" = "success"/,
    "a keyed skip or failure is red",
  );
  const artifact = step(gate, "keys present — the run artifact must exist");
  assert.ok(artifact !== null, "the wrapper downloads the run artifact");
  assert.match(artifact, /download-artifact@v4/);
  const nonEmpty = step(gate, "keys present — artifact must not be empty");
  assert.ok(nonEmpty !== null, "the wrapper refuses an empty artifact");
  assert.match(nonEmpty, /test -d demo-fast-run/);
});

test("nightly is English plus four Locale cores and weekly full is the same plan at three repetitions", () => {
  assert.equal(FAST_CALLS, 10);
  assert.equal(NIGHTLY_CALLS, ENGLISH_SCENARIOS + LOCALE_CORE_SCENARIOS * LOCALE_COUNT);
  assert.equal(FULL_CALLS, NIGHTLY_CALLS * 3);
  const nightly = job(NIGHTLY, "demo-nightly-health");
  assert.match(nightly, /demo:verify -- --nightly/);
  assert.match(nightly, /demo-gate-report\.mjs nightly/);
  const weekly = job(WEEKLY, "demo-weekly-full");
  assert.match(weekly, /demo:verify -- --full/);
  assert.match(weekly, /demo-gate-report\.mjs full/);

  // The gate reader imports the cadence's counts; it may not carry a copy.
  const reader = readFileSync(resolve(REPO, "voni/scripts/demo-gate-report.mjs"), "utf8");
  assert.match(
    reader,
    /from "\.\.\/src\/lib\/demo\/verification\/cadence\.ts"/,
    "the gate reader imports the one count source",
  );
  assert.doesNotMatch(
    reader,
    new RegExp(`\\b(${NIGHTLY_CALLS}|${FULL_CALLS})\\b`),
    "the gate reader must not restate a cadence count as a literal",
  );
});

test("the plan imports the cadence counts, so a hand-edited copy fails", () => {
  const plan = readFileSync(resolve(REPO, "voni/scripts/lib/verify-cli/plan.ts"), "utf8");
  assert.match(
    plan,
    /from "@\/lib\/demo\/verification\/cadence"/,
    "the plan imports the one count source",
  );
  assert.doesNotMatch(
    plan,
    new RegExp(`FULL_ENGLISH_SCENARIOS\\s*=\\s*${ENGLISH_SCENARIOS}`),
    "no literal English count",
  );
  assert.doesNotMatch(
    plan,
    new RegExp(`LOCALE_CORE_SCENARIOS\\s*=\\s*${LOCALE_CORE_SCENARIOS}`),
    "no literal Locale-core count",
  );
});

test("every new job has a timeout and a required wrapper that fails on skip, cancel or a missing artifact", () => {
  for (const [name, file] of RUN_JOBS) {
    assert.match(job(file, name), /timeout-minutes:/, `${name} needs a hang guard`);
  }
  for (const [runJob, wrapper, file] of WRAPPERS) {
    for (const [name, body] of jobs(file)) {
      assert.match(body, /timeout-minutes:/, `${name} in ${file} needs a hang guard`);
    }
    const gate = job(file, wrapper);
    assert.match(gate, new RegExp(`needs: \\[${runJob}\\]|needs: \\[[^\\]]*${runJob}`));
    assert.match(gate, /if: always\(\)/);
    assert.match(
      gate,
      new RegExp(`test "\\$\\{\\{ needs\\.${runJob}\\.result \\}\\}" = "success"`),
      `${wrapper} must fail a skipped or cancelled ${runJob}`,
    );
    assert.match(gate, /download-artifact@v4/, `${wrapper} must fail a missing artifact`);
  }
});

test("the named missing-key skip is a failure, never a green night or week", () => {
  for (const [file, runJob] of [
    [NIGHTLY, "demo-nightly-health"],
    [WEEKLY, "demo-weekly-full"],
  ] as const) {
    const gate = job(file, `required-${runJob}`);
    assert.match(gate, /needs\.demo-keys\.outputs\.present != 'true'/);
    assert.match(gate, /SKIPPED: demo (nightly|weekly)/);
    assert.match(gate, /exit 1/, "an absent key is a named failure");
    const runner = job(file, runJob);
    assert.match(runner, /if: needs\.demo-keys\.outputs\.present == 'true'/);
  }
});

test("no workflow commits audio or event evidence; only the certificate is an artifact", () => {
  for (const file of [CI, NIGHTLY, WEEKLY, MONTHLY]) {
    assert.doesNotMatch(file, /path:\s*voni\/evidence\/(?!certificates)/, "no evidence upload");
    assert.doesNotMatch(file, /git add|git commit|git push/, "CI never commits evidence");
  }
  for (const [runJob, file] of RUN_JOBS) {
    assert.match(job(file, runJob), /path: voni\/\.demo-runs\//, `${runJob} uploads the run dir`);
  }
  const weekly = job(WEEKLY, "demo-weekly-full");
  assert.match(weekly, /path: voni\/evidence\/certificates\/\*\.json/, "the certificate is the claim");
  const ignore = readFileSync(resolve(REPO, ".gitignore"), "utf8");
  for (const pattern of ["voni/.demo-runs/", "voni/.captures/", "voni/scoreboard-runs/", "voice-pipeline/.events/"]) {
    assert.ok(ignore.includes(pattern), `.gitignore must keep ${pattern} out of git`);
  }
});

test("new jobs take no literal vendor key and never soft-fail", () => {
  for (const [name, file] of [...RUN_JOBS, ["demo-monthly-production", MONTHLY] as const]) {
    const body = job(file, name);
    assert.doesNotMatch(body, /continue-on-error/, `${name} may not soft-fail`);
    for (const match of body.matchAll(/^\s+([A-Z][A-Z0-9_]*(?:API_KEY|_SECRET)):\s*(\S.*)$/gm)) {
      const value = match[2].trim();
      assert.ok(
        value.startsWith("${{ secrets.") || value.startsWith("${{ vars."),
        `${name} carries a literal ${match[1]}; a credential is a secret/vars reference only`,
      );
    }
    assert.doesNotMatch(body, /sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}/, `${name} has a literal key`);
  }
});

test("the monthly production job refuses by name rather than inventing a green", () => {
  const monthly = job(MONTHLY, "demo-monthly-production");
  assert.match(monthly, /demo:verify -- --full --target production/);
  assert.match(monthly, /demo-gate-report\.mjs full/);
  assert.match(monthly, /demo:cutover -- --monthly/);
});

test("the key gate reports presence by name and never reads a value", () => {
  const script = resolve(REPO, "scripts/demo-fast-keys.sh");

  const KEYS = [
    "META_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "VOICE_PIPELINE_ENVELOPE_SECRET",
  ] as const;

  const run = (keys: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "demo-fast-keys-"));
    const output = join(dir, "github-output");
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: output };
    for (const name of KEYS) delete env[name];
    Object.assign(env, keys);
    const stdout = execFileSync("bash", [script], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, outputs: readFileSync(output, "utf8") };
  };

  const absent = run({});
  assert.match(absent.stdout, /^SKIPPED: the demo fast contract made no call/);
  assert.match(absent.outputs, /^present=false$/m);
  assert.match(
    absent.outputs,
    /^missing=META_API_KEY, ASSEMBLYAI_API_KEY, VOICE_PIPELINE_ENVELOPE_SECRET$/m,
  );
  // The message names what is missing; it must never echo a value.
  assert.doesNotMatch(absent.stdout, /present=true/);

  const present = run({
    META_API_KEY: "value-a",
    ASSEMBLYAI_API_KEY: "value-b",
    VOICE_PIPELINE_ENVELOPE_SECRET: "value-c",
  });
  assert.match(present.stdout, /vendor keys present/);
  assert.match(present.outputs, /^present=true$/m);
  assert.doesNotMatch(present.stdout, /value-[abc]/);
});
