/**
 * The replay command card triage runs.
 *
 * This module is the one parser for the command a defect card emits, and it is
 * the contract the runner (ticket 11) and the CLI (ticket 28) accept unchanged:
 * `demo:verify --scenario <name> --target <target> --locale <locale>
 * --diagnose`. The parser accepts the same command under an `npm run
 * demo:verify --` prefix, because that is how the repository invokes it, and
 * refuses everything else by name — an extra mode, a missing Locale or an
 * unknown flag is bad input (exit 2), never a silently different reproduction.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Commands and exit codes".
 */

import { LOCALES, type Locale } from "../scenarios";

import { DefectCardError } from "./errors";
import { CARD_TARGETS, type CardTarget } from "./types";

export const REPLAY_PROGRAM = "demo:verify";

/** The one mode a defect card replays in: diagnosis, never certification. */
export const REPLAY_MODE = "diagnose";

export type ReplayReference = {
  readonly scenario: string;
  readonly target: CardTarget;
  readonly locale: Locale;
};

export type ReplayInvocation = ReplayReference & {
  readonly program: typeof REPLAY_PROGRAM;
  readonly mode: typeof REPLAY_MODE;
};

const VALUE_FLAGS = ["--scenario", "--target", "--locale"] as const;
const MODE_FLAG = "--diagnose";

/** Scenario names are corpus directory names: one lowercase slug, no path. */
const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The exact command a card carries; the parser below accepts it unchanged. */
export function replayCommand(reference: ReplayReference): string {
  return (
    `${REPLAY_PROGRAM} --scenario ${reference.scenario} ` +
    `--target ${reference.target} --locale ${reference.locale} ${MODE_FLAG}`
  );
}

function refuse(message: string): never {
  throw new DefectCardError("invalid-replay", message);
}

function one(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    refuse(`replay command is missing a value for ${flag}`);
  }
  return value;
}

/**
 * Parse one replay command. Tokens are whitespace-separated; a scenario name,
 * target and Locale never contain spaces, so quoting is not part of the
 * contract. The order of flags is free; a duplicate flag is refused.
 */
export function parseReplayCommand(command: string): ReplayInvocation {
  if (typeof command !== "string" || command.trim() === "") {
    refuse("replay command is empty");
  }
  const tokens = command.trim().split(/\s+/);

  let at = 0;
  if (tokens[at] === "npm") {
    if (tokens[at + 1] !== "run" || tokens[at + 2] !== REPLAY_PROGRAM) {
      refuse(
        `replay command must run "${REPLAY_PROGRAM}", got "${tokens.slice(0, 3).join(" ")}"`,
      );
    }
    at += 3;
    if (tokens[at] !== "--") {
      refuse(
        `replay command must pass the demo:verify arguments after "--"; ` +
          `got "${tokens[at] ?? ""}"`,
      );
    }
    at += 1;
  } else if (tokens[at] === REPLAY_PROGRAM) {
    at += 1;
  } else {
    refuse(
      `replay command must start with "${REPLAY_PROGRAM}", got "${tokens[0] ?? ""}"`,
    );
  }

  const values = new Map<string, string>();
  let diagnose = false;

  for (; at < tokens.length; at += 1) {
    const token = tokens[at] ?? "";
    if (token === MODE_FLAG) {
      if (diagnose) refuse(`replay command repeats ${MODE_FLAG}`);
      diagnose = true;
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      if (values.has(token)) refuse(`replay command repeats ${token}`);
      const value = tokens[at + 1];
      if (value === undefined) refuse(`replay command is missing a value for ${token}`);
      if (value.startsWith("--")) {
        refuse(`replay command is missing a value for ${token}; got "${value}"`);
      }
      values.set(token, value);
      at += 1;
      continue;
    }
    refuse(
      `replay command names "${token}", which is not part of ` +
        `"${REPLAY_PROGRAM} --scenario <name> --target <target> --locale <locale> ${MODE_FLAG}"`,
    );
  }

  const scenario = one(values.get("--scenario"), "--scenario");
  if (!SCENARIO_NAME.test(scenario)) {
    refuse(`replay scenario "${scenario}" is not a corpus scenario name`);
  }

  const target = one(values.get("--target"), "--target");
  if (!(CARD_TARGETS as readonly string[]).includes(target)) {
    refuse(
      `replay target "${target}" is not one of ${CARD_TARGETS.join(", ")}`,
    );
  }

  const locale = one(values.get("--locale"), "--locale");
  if (!(LOCALES as readonly string[]).includes(locale)) {
    refuse(`replay locale "${locale}" is not one of ${LOCALES.join(", ")}`);
  }

  if (!diagnose) {
    refuse(`replay command must ask for ${MODE_FLAG}; a card is never replayed as a certification`);
  }

  return {
    program: REPLAY_PROGRAM,
    scenario,
    target: target as CardTarget,
    locale: locale as Locale,
    mode: REPLAY_MODE,
  };
}
