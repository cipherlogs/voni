/**
 * `npm run demo:baseline:verify` — prove the human baseline is complete and
 * unchanged, or refuse by name.
 *
 * The owner records three to five people, two calls each, in the Studio's
 * Corpus surface. This command is the gate on that work: it rehashes every
 * baseline take, measures the call length, checks the consent reference beside
 * the takes, and reproduces the pinned hash list. `--record` pins the list once;
 * later runs only verify, so a changed take can never quietly become the new
 * baseline.
 *
 * Exit 0 pass, 2 refusal. Nothing here records or invents participant data.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BaselineError, verifyBaseline } from "./baseline";

const HERE = dirname(fileURLToPath(import.meta.url));
const VONI_ROOT = resolve(HERE, "../..");

const USAGE = `Usage: npm run demo:baseline:verify -- [--root <dir>] [--manifest <file>] [--consent-root <dir>] [--certification-root <dir>] [--record]

  --root                 Studio take store root; default voni/.studio
  --manifest             pinned hash list; default <root>/baseline-hashes.json
  --consent-root         signed consent references beside the takes; default <root>/consent
  --certification-root   extra committed artifact root scanned for a baseline
                         id or digest; default scenario corpus + evidence/certificates
  --record               pin the current list once; refuses if a manifest exists

The baseline is three to five consenting people, two calls of four to six
minutes each, used only as blind comparison audio. A missing consent reference,
a missing take, a call outside the band, an edited take or a take used as a
certification input is a named refusal.`;

type Args = {
  root: string;
  manifest?: string;
  consentRoot?: string;
  certificationRoots: string[];
  record: boolean;
};

function fail(message: string): never {
  process.stderr.write(`demo:baseline:verify: invalid-argument: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let root = resolve(VONI_ROOT, ".studio");
  let manifest: string | undefined;
  let consentRoot: string | undefined;
  const certificationRoots: string[] = [];
  let record = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flag === "--record") {
      record = true;
      continue;
    }
    if (!flag.startsWith("--")) fail(`unexpected argument ${JSON.stringify(flag)}\n${USAGE}`);
    const value = argv[index + 1];
    if (value === undefined) fail(`${flag} needs a value\n${USAGE}`);
    index += 1;
    if (flag === "--root") {
      root = resolve(value);
    } else if (flag === "--manifest") {
      manifest = resolve(value);
    } else if (flag === "--consent-root") {
      consentRoot = resolve(value);
    } else if (flag === "--certification-root") {
      certificationRoots.push(resolve(value));
    } else {
      fail(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  return {
    root,
    ...(manifest ? { manifest } : {}),
    ...(consentRoot ? { consentRoot } : {}),
    certificationRoots,
    record,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await verifyBaseline({
    root: args.root,
    ...(args.manifest ? { manifestPath: args.manifest } : {}),
    ...(args.consentRoot ? { consentRoot: args.consentRoot } : {}),
    certificationRoots: [
      resolve(VONI_ROOT, "src/lib/demo/verification/scenarios/corpus"),
      resolve(VONI_ROOT, "evidence/certificates"),
      ...args.certificationRoots,
    ],
    record: args.record,
  });
  for (const take of report.takes) {
    const duration = `${(take.durationMs / 60_000).toFixed(2)} min`;
    process.stdout.write(
      `demo:baseline:verify: ${take.participantId} call ${take.call} ${take.takeId} ${duration} ${take.audioSha256} consent ${take.consentRef}\n`,
    );
  }
  const verb = report.pinned ? "pinned" : "verified";
  process.stdout.write(
    `demo:baseline:verify: ${verb} ${report.takes.length} takes for ${report.participants} participants ` +
      `against ${report.manifestPath}\n`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    if (error instanceof BaselineError) {
      process.stderr.write(`demo:baseline:verify: ${error.code}: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`demo:baseline:verify: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
