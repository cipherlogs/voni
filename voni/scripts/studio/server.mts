/**
 * `npm run demo:studio` — start the local-only Studio on loopback.
 *
 * This file is the operator join: argv, the store root and the printed URL.
 * Everything testable lives in `./http.ts`, `./take-store.ts` and
 * `./dialogues.ts`. The process refuses a production environment by name and
 * binds loopback only; it is not a Next route, so a deployed build cannot
 * contain it.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { StudioError } from "./take-store";
import { assertLocalOnly, startStudio } from "./http";

const HERE = dirname(fileURLToPath(import.meta.url));
const VONI_ROOT = resolve(HERE, "../..");

const USAGE = `Usage: npm run demo:studio -- [--port <n>] [--host <loopback>] [--root <dir>] [--dialogues <dir>] [--evidence-root <dir>] [--rating-root <dir>]

  --port           loopback port; default 4317, 0 asks the OS for a free one
  --host           loopback host only; default 127.0.0.1
  --root           take store root; default voni/.studio
  --dialogues      authored dialogue scripts; default scripts/studio/dialogues
  --evidence-root  run evidence the Rate surface may read; default voni/evidence
  --rating-root    rating session root; default <root>/rating`;

type Args = {
  port: number;
  host: string;
  root: string;
  dialogues?: string;
  evidenceRoot?: string;
  ratingRoot?: string;
};

function fail(message: string): never {
  process.stderr.write(`demo:studio: invalid-argument: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let port = 4317;
  let host = "127.0.0.1";
  let root = resolve(VONI_ROOT, ".studio");
  let dialogues: string | undefined;
  let evidenceRoot: string | undefined;
  let ratingRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (!flag.startsWith("--")) fail(`unexpected argument ${JSON.stringify(flag)}\n${USAGE}`);
    if (value === undefined) fail(`${flag} needs a value\n${USAGE}`);
    index += 1;
    if (flag === "--port") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        fail(`--port must be 0–65535, got ${JSON.stringify(value)}`);
      }
      port = parsed;
    } else if (flag === "--host") {
      host = value;
    } else if (flag === "--root") {
      root = resolve(value);
    } else if (flag === "--dialogues") {
      dialogues = resolve(value);
    } else if (flag === "--evidence-root") {
      evidenceRoot = resolve(value);
    } else if (flag === "--rating-root") {
      ratingRoot = resolve(value);
    } else {
      fail(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  return {
    port,
    host,
    root,
    ...(dialogues ? { dialogues } : {}),
    ...(evidenceRoot ? { evidenceRoot } : {}),
    ...(ratingRoot ? { ratingRoot } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertLocalOnly(process.env);
  const studio = await startStudio({ ...args, env: process.env });
  process.stdout.write(
    `demo:studio: recording at ${studio.url}\n` +
      `demo:studio: takes land in ${args.root} (local only; the deployed build has no Studio)\n`,
  );
  const stop = async (): Promise<void> => {
    await studio.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    if (error instanceof StudioError) {
      process.stderr.write(`demo:studio: ${error.code}: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`demo:studio: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
