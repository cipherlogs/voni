/**
 * The `demo:verify` argv contract: targets, modes, the optional Locale filter
 * and the single-scenario diagnose form. Every rejection is bad input (exit 2),
 * never a silently different run, and a defect card's replay command is
 * accepted unchanged.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseReplayCommand, replayCommand } from "@/lib/demo/verification/cards";

import { parseVerifyArgs } from "./args";
import { VerifyCliError } from "./errors";

function refusal(argv: readonly string[]): VerifyCliError {
  try {
    parseVerifyArgs(argv);
  } catch (error) {
    assert.ok(error instanceof VerifyCliError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.exitCode, 2);
    return error;
  }
  assert.fail(`expected ${argv.join(" ")} to be refused`);
}

test("the spec's three forms parse to one request each", () => {
  const full = parseVerifyArgs(["--target", "local", "--full"]);
  assert.equal(full.mode, "full");
  assert.equal(full.target, "local");
  assert.equal(full.locale, undefined);
  assert.equal(full.scenario, undefined);

  const diagnose = parseVerifyArgs([
    "--scenario",
    "golden-flow-hello",
    "--target",
    "local",
    "--diagnose",
  ]);
  assert.equal(diagnose.mode, "diagnose");
  assert.equal(diagnose.scenario, "golden-flow-hello");

  const locale = parseVerifyArgs(["--locale", "de"]);
  assert.equal(locale.locale, "de");
  assert.equal(locale.mode, "full", "no mode flag is the full certification, never a smaller run");
  assert.equal(locale.target, "local", "an omitted target is local, the only target with a sink");
});

test("a defect card's replay command is accepted unchanged", () => {
  const command = replayCommand({
    scenario: "turn-taking-barge",
    target: "local",
    locale: "en",
  });
  const parsed = parseVerifyArgs(command.split(" "));
  const replay = parseReplayCommand(command);
  assert.equal(parsed.mode, "diagnose");
  assert.equal(parsed.scenario, replay.scenario);
  assert.equal(parsed.target, replay.target);
  assert.equal(parsed.locale, replay.locale);
});

test("the npm script prefix is accepted, with or without the separator", () => {
  const withSeparator = parseVerifyArgs([
    "npm",
    "run",
    "demo:verify",
    "--",
    "--target",
    "local",
    "--fast",
  ]);
  assert.equal(withSeparator.mode, "fast");
  assert.equal(withSeparator.target, "local");

  const bareProgram = parseVerifyArgs(["demo:verify", "--target", "local", "--fast"]);
  assert.equal(bareProgram.mode, "fast");
});

test("every mode flag is a mode, and two modes are bad input", () => {
  for (const flag of ["--diagnose", "--fast", "--nightly", "--full"] as const) {
    const mode = flag.slice(2);
    const argv =
      flag === "--diagnose"
        ? ["--scenario", "golden-flow-hello", flag]
        : ["--target", "local", flag];
    assert.equal(parseVerifyArgs(argv).mode, mode);
  }
  const error = refusal(["--target", "local", "--fast", "--full"]);
  assert.match(error.message, /exactly one mode/);
});

test("an unknown target, Locale, flag or positional argument is refused by name", () => {
  assert.match(refusal(["--target", "qa", "--fast"]).message, /unknown target "qa"/);
  assert.match(refusal(["--locale", "it"]).message, /unknown Locale "it"/);
  assert.match(refusal(["--target", "local", "--speed"]).message, /unknown flag "--speed"/);
  assert.match(refusal(["local"]).message, /unexpected argument "local"/);
});

test("a value flag without a value is refused before any default", () => {
  assert.match(refusal(["--target"]).message, /--target needs a value/);
  assert.match(refusal(["--locale", "--fast"]).message, /--locale needs a value/);
});

test("diagnose needs exactly one scenario; every other mode refuses one", () => {
  assert.match(refusal(["--target", "local", "--diagnose"]).message, /--diagnose needs --scenario/);
  assert.match(
    refusal(["--scenario", "golden-flow-hello", "--target", "local", "--fast"]).message,
    /--scenario belongs to --diagnose/,
  );
});

test("a scenario name that is not a corpus slug is refused", () => {
  assert.match(
    refusal(["--scenario", "../escape", "--diagnose"]).message,
    /not a scenario name/,
  );
});

test("the fast contract speaks English only", () => {
  const error = refusal(["--target", "local", "--fast", "--locale", "es"]);
  assert.match(error.message, /fast contract speaks en/);
  assert.equal(parseVerifyArgs(["--target", "local", "--fast", "--locale", "en"]).locale, "en");
});

test("Adapter flags pass through; an unknown value is still bad input", () => {
  const request = parseVerifyArgs([
    "--target",
    "local",
    "--fast",
    "--app-url",
    "http://localhost:3000",
    "--events-dir",
    "/tmp/events",
    "--timing-lock",
    "/tmp/lock",
    "--json",
  ]);
  assert.equal(request.appUrl, "http://localhost:3000");
  assert.equal(request.eventsDir, "/tmp/events");
  assert.equal(request.timingLockPath, "/tmp/lock");
  assert.equal(request.json, true);
});

test("--help is a request for usage, not a run", () => {
  const help = parseVerifyArgs(["--help"]);
  assert.equal(help.help, true);
});
