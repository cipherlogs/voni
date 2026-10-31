/**
 * The `demo:cutover` argv contract (ticket 29): one action per invocation and
 * the flags that action reads. Parsing decides what was asked; every gate
 * judges committed evidence later. A duplicate action, an unknown flag or a
 * malformed value is exit 2 before any file is read.
 */

import type { CertificateTarget } from "../../src/lib/demo/verification/certificate";

export const CUTOVER_ACTIONS = [
  "--streak",
  "--gate",
  "--post-flip",
  "--rollback",
  "--monthly",
] as const;

export type CutoverAction = (typeof CUTOVER_ACTIONS)[number];

const VALUE_FLAGS = new Set([
  "--target",
  "--image",
  "--certificate",
  "--staging",
  "--proof",
  "--record",
  "--now",
]);

export type CutoverOptions = {
  action: CutoverAction;
  target: CertificateTarget;
  image: string;
  certificate: string;
  postFlip: string;
  staging: string;
  proof: string;
  record: string;
  now: string;
  json: boolean;
  help: boolean;
};

export class CutoverUsageError extends Error {}

function argValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CutoverUsageError(`${flag} needs a value`);
  }
  return value;
}

export function parseCutoverOptions(argv: readonly string[]): CutoverOptions {
  const values = new Map<string, string>();
  const actions: CutoverAction[] = [];
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--post-flip") {
      actions.push("--post-flip");
      values.set("--post-flip", argValue(argv, index, token));
      index += 1;
      continue;
    }
    if ((CUTOVER_ACTIONS as readonly string[]).includes(token)) {
      actions.push(token as CutoverAction);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      values.set(token, argValue(argv, index, token));
      index += 1;
      continue;
    }
    throw new CutoverUsageError(`unknown option ${JSON.stringify(token)}`);
  }
  if (help) {
    return {
      action: "--streak",
      target: "staging",
      image: "",
      certificate: "",
      postFlip: "",
      staging: "",
      proof: "",
      record: "",
      now: "",
      json,
      help: true,
    };
  }
  if (actions.length !== 1) {
    throw new CutoverUsageError(
      `exactly one action is required (${CUTOVER_ACTIONS.join(", ")}); got ${
        actions.length === 0 ? "none" : actions.join(", ")
      }`,
    );
  }
  const target = (values.get("--target") ?? "staging") as CertificateTarget;
  if (!["local", "staging", "production"].includes(target)) {
    throw new CutoverUsageError(`unknown target "${String(target)}"`);
  }
  const now = values.get("--now") ?? "";
  if (now !== "" && Number.isNaN(Date.parse(now))) {
    throw new CutoverUsageError(`--now "${now}" is not a date`);
  }
  return {
    action: actions[0],
    target,
    image: values.get("--image") ?? "",
    certificate: values.get("--certificate") ?? "",
    postFlip: values.get("--post-flip") ?? "",
    staging: values.get("--staging") ?? "",
    proof: values.get("--proof") ?? "",
    record: values.get("--record") ?? "",
    now,
    json,
    help: false,
  };
}
