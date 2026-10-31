import test from "node:test";
import assert from "node:assert/strict";

import { LOCALES } from "../scenarios";
import {
  CARD_TARGETS,
  DefectCardError,
  parseReplayCommand,
  replayCommand,
  type CardTarget,
  type ReplayInvocation,
} from "./index";

/**
 * The replay command's contract. Ticket 11's runner and ticket 28's CLI must
 * accept this command unchanged; every refusal below is bad input (exit 2),
 * never a quietly different reproduction.
 */

function assertRefusal(command: string, pattern: RegExp): void {
  assert.throws(
    () => parseReplayCommand(command),
    (error: unknown) => {
      assert.ok(error instanceof DefectCardError, `expected DefectCardError, got ${String(error)}`);
      assert.equal(error.code, "invalid-replay");
      assert.equal(error.exitCode, 2);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

test("the parser accepts every command a card can emit, unchanged", () => {
  for (const target of CARD_TARGETS) {
    for (const locale of LOCALES) {
      const command = replayCommand({ scenario: "golden-flow", target, locale });
      assert.equal(
        command,
        `demo:verify --scenario golden-flow --target ${target} --locale ${locale} --diagnose`,
      );
      const invocation: ReplayInvocation = parseReplayCommand(command);
      assert.deepEqual(invocation, {
        program: "demo:verify",
        scenario: "golden-flow",
        target: target as CardTarget,
        locale,
        mode: "diagnose",
      });
    }
  }
});

test("the parser accepts the repository's npm invocation of the same command", () => {
  assert.deepEqual(
    parseReplayCommand(
      "npm run demo:verify -- --scenario golden-flow --target local --locale pt --diagnose",
    ),
    {
      program: "demo:verify",
      scenario: "golden-flow",
      target: "local",
      locale: "pt",
      mode: "diagnose",
    },
  );
});

test("the parser accepts flags in any order", () => {
  assert.deepEqual(
    parseReplayCommand(
      "demo:verify --diagnose --locale de --target staging --scenario speakerphone",
    ),
    {
      program: "demo:verify",
      scenario: "speakerphone",
      target: "staging",
      locale: "de",
      mode: "diagnose",
    },
  );
});

test("a command without diagnosis mode is refused", () => {
  assertRefusal(
    "demo:verify --scenario golden-flow --target local --locale en",
    /must ask for --diagnose/,
  );
});

test("a certification mode cannot be smuggled into a replay", () => {
  assertRefusal(
    "demo:verify --scenario golden-flow --target local --locale en --diagnose --fast",
    /names "--fast"/,
  );
  assertRefusal(
    "demo:verify --scenario golden-flow --target local --locale en --full --diagnose",
    /names "--full"/,
  );
});

test("an unknown flag or positional token is refused by name", () => {
  assertRefusal(
    "demo:verify --scenario golden-flow --target local --locale en --diagnose --json",
    /names "--json"/,
  );
  assertRefusal(
    "demo:verify golden-flow --target local --locale en --diagnose",
    /names "golden-flow"/,
  );
});

test("a repeated flag is refused instead of taking the last value", () => {
  assertRefusal(
    "demo:verify --scenario golden-flow --scenario barge-in --target local --locale en --diagnose",
    /repeats --scenario/,
  );
});

test("a missing value is refused instead of consuming the next flag", () => {
  assertRefusal(
    "demo:verify --scenario --target local --locale en --diagnose",
    /missing a value for --scenario; got "--target"/,
  );
  assertRefusal(
    "demo:verify --scenario golden-flow --target local --locale",
    /missing a value for --locale/,
  );
});

test("an unknown target or Locale is refused by name", () => {
  assertRefusal(
    "demo:verify --scenario golden-flow --target prod --locale en --diagnose",
    /target "prod"/,
  );
  assertRefusal(
    "demo:verify --scenario golden-flow --target local --locale it --diagnose",
    /locale "it"/,
  );
});

test("a scenario name cannot escape the corpus directory", () => {
  assertRefusal(
    "demo:verify --scenario ../../etc/passwd --target local --locale en --diagnose",
    /not a corpus scenario name/,
  );
  assertRefusal(
    "demo:verify --scenario Golden_Flow --target local --locale en --diagnose",
    /not a corpus scenario name/,
  );
});

test("a command that is not demo:verify is refused", () => {
  assertRefusal("npm run demo:studio -- --scenario x", /must run "demo:verify"/);
  assertRefusal("demo:certificate --panel p --reviewer r", /must start with "demo:verify"/);
  assertRefusal("   ", /empty/);
});

test("the npm form must separate the script's arguments with --", () => {
  assertRefusal(
    "npm run demo:verify --scenario golden-flow --target local --locale en --diagnose",
    /after "--"/,
  );
});
