/**
 * `demo:usage`'s argv contract: exactly one of `--run <id>` or `--latest`.
 *
 * Parsing only decides what was asked. It never reads evidence and never
 * resolves a run id; the command refuses a missing run, an unknown id or a torn
 * row later, by name.
 */

import { refuse } from "./types";

export const USAGE =
  "usage: npm run demo:usage -- (--run <runId> | --latest) " +
  "[--run-root <path>] [--evidence-root <path>]";

export type UsageRequest = {
  readonly runId?: string;
  readonly latest: boolean;
  readonly runRoot?: string;
  readonly evidenceRoot?: string;
  readonly help: boolean;
};

const VALUE_FLAGS = {
  "--run": "runId",
  "--run-root": "runRoot",
  "--evidence-root": "evidenceRoot",
} as const;

type ValueFlag = keyof typeof VALUE_FLAGS;
type ValueField = (typeof VALUE_FLAGS)[ValueFlag];

/** Strip the repository's invocation prefix; a foreign program is bad input. */
function stripProgram(argv: readonly string[]): readonly string[] {
  if (argv[0] === "demo:usage") return argv.slice(1);
  if (argv[0] !== "npm") return argv;
  if (argv[1] !== "run" || argv[2] !== "demo:usage") {
    refuse(
      "bad-input",
      `the command must run "demo:usage", got "${argv.slice(0, 3).join(" ")}"`,
    );
  }
  const rest = argv.slice(3);
  if (rest[0] === "--") return rest.slice(1);
  return rest;
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseUsageArgs(argv: readonly string[]): UsageRequest {
  const tokens = stripProgram(argv);
  const values: Partial<Record<ValueField, string>> = {};
  let latest = false;
  let help = false;

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] as string;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--latest") {
      if (latest) refuse("bad-input", "--latest is given twice");
      latest = true;
      continue;
    }
    if (token in VALUE_FLAGS) {
      const flag = token as ValueFlag;
      const value = tokens[at + 1];
      if (value === undefined || value.startsWith("--")) {
        refuse("bad-input", `${flag} needs a value`);
      }
      const field = VALUE_FLAGS[flag];
      if (values[field] !== undefined) {
        refuse("bad-input", `${flag} is given twice; one value is enough`);
      }
      values[field] = value;
      at += 1;
      continue;
    }
    if (token.startsWith("-")) refuse("bad-input", `unknown flag "${token}"`);
    refuse("bad-input", `unexpected argument "${token}"`);
  }

  if (help) {
    return { latest, help: true };
  }

  const runId = values.runId;
  if (latest && runId !== undefined) {
    refuse("bad-input", "choose one of --run <runId> or --latest, not both");
  }
  if (!latest && runId === undefined) {
    refuse("bad-input", "choose one of --run <runId> or --latest");
  }
  if (runId !== undefined && (!SAFE_RUN_ID.test(runId) || runId.includes(".."))) {
    refuse(
      "bad-input",
      `"${runId}" is not a safe run id; use letters, digits, dot, dash or underscore`,
    );
  }
  return {
    ...(runId === undefined ? {} : { runId }),
    latest,
    ...(values.runRoot === undefined ? {} : { runRoot: values.runRoot }),
    ...(values.evidenceRoot === undefined ? {} : { evidenceRoot: values.evidenceRoot }),
    help: false,
  };
}
