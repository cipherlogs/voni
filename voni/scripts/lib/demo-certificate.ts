/**
 * `demo:certificate` — sign a clean certificate with the owner's panel session,
 * or report a certificate's verdict.
 *
 *   npm run demo:certificate -- --panel <session-id> --reviewer <name> \
 *     [--certificate <path>] [--studio-root <dir>] [--evidence-root <dir>] [--date <YYYY-MM-DD>]
 *
 *   npm run demo:certificate -- --certificate <path>
 *
 * Signing reads the blind panel session and its ratings from the local Studio
 * store, verifies the session belongs to this certificate's run and target,
 * produces the attestation, completes H7 and writes the certificate back. It
 * never invents a reviewer, a date or a rating: a missing reviewer, a different
 * reviewer, a missing date or a different run is a named refusal (exit 2).
 *
 * Reporting an unsigned certificate prints `pending-human` and exits 3; it is
 * never called a pass.
 */

import { renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CERTIFICATE_REFUSAL_EXIT_CODE,
  CertificateError,
  certificateExitCode,
  certificateFile,
  readCertificate,
  renderCertificate,
  serializeCertificate,
} from "../../src/lib/demo/verification/certificate";
import { PanelError } from "../../src/lib/demo/verification/panel";
import { openRatingStore } from "../studio/rating-store";
import {
  completeCertificateSignature,
  exportGoldLabels,
  signPanel,
  verifyPanelSignature,
} from "../studio/panel";

const VONI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_STUDIO_ROOT = join(VONI_ROOT, ".studio/rating");

const USAGE = `Usage:
  npm run demo:certificate -- --panel <session-id> --reviewer <name>
  npm run demo:certificate -- --certificate <path>

Sign:
  --panel <id>           the Studio rating session the owner rated
  --reviewer <name>      the reviewer who rated and signs (must match the session)
  --certificate <path>   the unsigned certificate (default: voni/evidence/certificates/<run>.json)
  --studio-root <dir>    rating session root (default: voni/.studio/rating)
  --evidence-root <dir>  root the session's audio paths are relative to (default: voni)
  --date <YYYY-MM-DD>    optional confirmation of the session date

Report:
  --certificate <path>   read and validate one certificate; exit 3 while pending-human

Exit codes: 0 certified, 1 not-demo-ready or ineligible, 2 bad input or missing
evidence, 3 pending human panel.`;

const ALLOWED = new Set([
  "--panel",
  "--reviewer",
  "--certificate",
  "--studio-root",
  "--evidence-root",
  "--date",
  "--help",
  "-h",
]);

function arg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function refusedInput(message: string): number {
  process.stderr.write(`demo:certificate: ${message}\n`);
  return CERTIFICATE_REFUSAL_EXIT_CODE;
}

function writeCertificate(path: string, document: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, document, "utf8");
  renameSync(temporary, path);
}

async function sign(argv: readonly string[]): Promise<number> {
  const sessionId = arg(argv, "--panel");
  const reviewer = arg(argv, "--reviewer");
  if (sessionId === undefined) {
    return refusedInput("--panel <session-id> is required to sign");
  }
  if (reviewer === undefined) {
    return refusedInput("--reviewer <name> is required to sign; a signature is never anonymous");
  }

  const studioRoot = arg(argv, "--studio-root") ?? DEFAULT_STUDIO_ROOT;
  const evidenceRoot = arg(argv, "--evidence-root") ?? VONI_ROOT;
  const store = await openRatingStore({ root: studioRoot, evidenceRoot });
  const session = await store.get(sessionId);
  const ratings = await store.ratings(sessionId);

  const certificatePath =
    arg(argv, "--certificate") ??
    fileURLToPath(certificateFile(session.runId));
  const absolute = isAbsolute(certificatePath) ? certificatePath : resolve(process.cwd(), certificatePath);
  const certificate = readCertificate(absolute);

  const signature = signPanel({
    certificate,
    session,
    ratings,
    reviewer,
    ...(arg(argv, "--date") === undefined ? {} : { signedAt: arg(argv, "--date")! }),
  });
  const labels = exportGoldLabels({ session, ratings });
  const completed = completeCertificateSignature(certificate, signature, labels);
  verifyPanelSignature({ certificate: completed, session, ratings });
  writeCertificate(absolute, serializeCertificate(completed));

  process.stdout.write(`${renderCertificate(completed)}\n`);
  return certificateExitCode(completed.verdict);
}

function report(argv: readonly string[]): number {
  const path = arg(argv, "--certificate");
  if (path === undefined) {
    return refusedInput("one of --panel/--reviewer or --certificate is required");
  }
  const certificate = readCertificate(isAbsolute(path) ? path : resolve(process.cwd(), path));
  process.stdout.write(renderCertificate(certificate));
  return certificateExitCode(certificate.verdict);
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return argv.length === 0 ? CERTIFICATE_REFUSAL_EXIT_CODE : 0;
  }
  for (const token of argv) {
    if (token.startsWith("--") && !ALLOWED.has(token)) {
      return refusedInput(`unknown flag ${token}; see --help`);
    }
  }

  try {
    if (arg(argv, "--panel") !== undefined) {
      return await sign(argv);
    }
    return report(argv);
  } catch (error) {
    if (error instanceof PanelError) {
      process.stderr.write(`demo:certificate: ${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof CertificateError) {
      process.stderr.write(`demo:certificate: ${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(`demo:certificate: ${(error as Error).message}\n`);
    return CERTIFICATE_REFUSAL_EXIT_CODE;
  }
}
