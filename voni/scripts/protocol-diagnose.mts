/**
 * `npm run demo:diagnose:protocol -- "demo:verify --scenario ... --target local
 * --locale en --diagnose"` — the protocol adapter's operator join.
 *
 * This is not the `demo:verify` CLI (ticket 28 owns targets, modes and the
 * final exit-code contract). It exists so ticket 11's runner can execute the
 * replay command a defect card carries, unchanged, against the real service.
 * It never writes a certificate and never returns 0: the protocol adapter
 * diagnoses.
 */

import { pathToFileURL } from "node:url";

import {
  PROTOCOL_REFUSAL_EXIT_CODE,
  ProtocolAdapterError,
  runReplayCommand,
} from "./lib/protocol-adapter";

function usage(): string {
  return (
    'usage: npm run demo:diagnose:protocol -- "demo:verify --scenario <name> ' +
    '--target <local|staging|production> --locale <en|es|fr|de|pt> --diagnose"'
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv.join(" ").trim();
  if (command === "" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return command === "" ? PROTOCOL_REFUSAL_EXIT_CODE : 0;
  }

  try {
    const result = await runReplayCommand(command, {});
    process.stdout.write(
      `${result.status}: ${result.runId}\n` +
        `run directory: ${result.runDir}\n` +
        `verdict: ${result.verdict?.detail ?? "no verdict (refused)"}\n` +
        `certification: withheld (the protocol adapter diagnoses, never certifies)\n`,
    );
    return result.exitCode;
  } catch (error) {
    if (error instanceof ProtocolAdapterError) {
      process.stderr.write(`protocol-diagnose: ${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(`protocol-diagnose: ${(error as Error).message}\n`);
    return PROTOCOL_REFUSAL_EXIT_CODE;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`protocol-diagnose: ${(error as Error).message}\n`);
      process.exitCode = PROTOCOL_REFUSAL_EXIT_CODE;
    });
}
