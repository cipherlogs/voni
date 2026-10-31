/**
 * `npm run demo:cutover` — the release and cutover gates (ticket 29).
 *
 *   npm run demo:cutover -- --streak [--target staging] [--dir <certificates>]
 *   npm run demo:cutover -- --gate --image <sha256:...> [--certificate <path>]
 *   npm run demo:cutover -- --post-flip <record.json> --image <image> --staging <run-id>
 *   npm run demo:cutover -- --rollback [--proof <record.json>]
 *   npm run demo:cutover -- --monthly [--record <monthly.json>] [--image <image>]
 *
 * Every action reads committed certificates and records. Nothing runs a call,
 * opens a vendor or invents evidence. Exit codes are the spec's: 0 open/current,
 * 1 blocked/overdue, 2 bad input or missing evidence, 3 pending-human.
 *
 * The production flip itself remains the operator's human act:
 * `npm run cutover:check -- --set production` with an operator and a reason,
 * after this gate opens. The rollback is `--set off`; its proof is
 * `cutover:check -- --prove-off`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CERTIFICATES_DIR,
  CertificateError,
  readCertificate,
  type Certificate,
  type CertificateTarget,
} from "../src/lib/demo/verification/certificate";
import {
  CutoverUsageError,
  parseCutoverOptions,
  type CutoverOptions,
} from "./lib/cutover-options";
import {
  MONTHLY_PRODUCTION_CRON,
  ReleaseError,
  evaluateCertificateStreak,
  evaluateCutoverGate,
  evaluateMonthlyProduction,
  evaluatePostFlipConfirmation,
  evaluateRollback,
  monthlyProductionRecord,
  parseMonthlyProductionRecord,
  parsePostFlipConfirmation,
  parseRollbackRecord,
  rollbackRoutingValue,
  type MonthlyProductionRecord,
  type PostFlipConfirmation,
  type RollbackRecord,
} from "../src/lib/demo/verification/release";

const USAGE = `usage: npm run demo:cutover -- <action> [options]

  --streak                  judge the latest three certifications for a target
  --gate                    staging certificate for an image gates the flip
  --post-flip <path>        read and judge a committed post-flip confirmation
  --rollback                print the one rollback value and judge its proof
  --monthly                 judge the scheduled monthly production certification

  --target <local|staging|production>  streak target (default staging)
  --image <sha256:...>      the image being certified/flipped
  --certificate <path>      one staging certificate instead of the directory
  --staging <run-id>        the staging certificate a confirmation follows
  --proof <path>            the kill-switch proof record
  --record <path>           the monthly record (default evidence/cutover/monthly-production.json)
  --now <iso>               judge the month containing this instant
  --json                    print one machine-readable result
  --help, -h                this text

The monthly schedule is "${MONTHLY_PRODUCTION_CRON}" (UTC). An empty monthly
record is pending-human (exit 3), never green. Production runs need an evidence
sink this repository does not have; they refuse by name.`;

function certificatesDir(): string {
  return fileURLToPath(CERTIFICATES_DIR);
}

type ReadCertificates = {
  certificates: Certificate[];
  unreadable: { path: string; reason: string }[];
};

/** Read every committed certificate; an unreadable file is named, never skipped. */
export function readCertificates(dir: string): ReadCertificates {
  const certificates: Certificate[] = [];
  const unreadable: { path: string; reason: string }[] = [];
  if (!existsSync(dir)) return { certificates, unreadable };
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of names) {
    const path = resolve(dir, name);
    try {
      certificates.push(readCertificate(path));
    } catch (error) {
      if (error instanceof CertificateError) {
        unreadable.push({ path, reason: `${error.code}: ${error.message}` });
        continue;
      }
      throw error;
    }
  }
  return { certificates, unreadable };
}

function defaultRecordPath(): string {
  return fileURLToPath(
    new URL("../evidence/cutover/monthly-production.json", import.meta.url),
  );
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ReleaseError(
      "missing-evidence",
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ReleaseError(
      "invalid-record",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function printJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function reportLines(title: string, lines: readonly string[]): string[] {
  return [title, ...lines.map((line) => `  ${line}`)];
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CutoverOptions;
  try {
    options = parseCutoverOptions(argv);
  } catch (error) {
    if (error instanceof CutoverUsageError) {
      process.stderr.write(`demo:cutover: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (options.action === "--rollback") {
    const record: RollbackRecord | null =
      options.proof === ""
        ? null
        : parseRollbackRecord(readJson(resolve(options.proof)));
    const evaluated = evaluateRollback(record);
    if (options.json) {
      printJson({ action: "rollback", ...evaluated });
    } else {
      process.stdout.write(
        [
          `rollback routing value: ${rollbackRoutingValue()}`,
          `proof: ${evaluated.detail}`,
          ...evaluated.checks.map(
            (check) => `  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`,
          ),
          "",
        ].join("\n"),
      );
    }
    return evaluated.exitCode;
  }

  if (options.action === "--post-flip") {
    if (options.image.trim() === "") {
      throw new CutoverUsageError("--post-flip needs --image <sha256:...>");
    }
    if (options.staging.trim() === "") {
      throw new CutoverUsageError("--post-flip needs --staging <run-id> (the certificate it followed)");
    }
    const confirmation: PostFlipConfirmation = parsePostFlipConfirmation(
      readJson(resolve(options.postFlip)),
    );
    const evaluated = evaluatePostFlipConfirmation(confirmation, {
      image: options.image,
      stagingCertificateRunId: options.staging,
    });
    if (options.json) {
      printJson({ action: "post-flip", confirmation, ...evaluated });
    } else {
      process.stdout.write(`${reportLines("post-flip confirmation", [evaluated.detail]).join("\n")}\n`);
    }
    return evaluated.exitCode;
  }

  const loaded = readCertificates(certificatesDir());
  if (loaded.unreadable.length > 0) {
    const detail = loaded.unreadable.map((entry) => `${basename(entry.path)}: ${entry.reason}`).join("; ");
    if (options.json) printJson({ action: options.action, ok: false, detail });
    else process.stderr.write(`demo:cutover: unreadable certificate(s): ${detail}\n`);
    return 2;
  }

  if (options.action === "--streak") {
    const streak = evaluateCertificateStreak({
      certificates: loaded.certificates,
      target: options.target,
    });
    if (options.json) printJson({ action: "streak", ...streak });
    else {
      process.stdout.write(
        `${reportLines(`certification streak (${options.target})`, [
          streak.detail,
          ...streak.breaks.map((entry) => `BREAK ${entry.code}: ${entry.detail}`),
        ]).join("\n")}\n`,
      );
    }
    return streak.ok ? 0 : streak.count < 3 ? 2 : 1;
  }

  if (options.action === "--gate") {
    if (options.image.trim() === "") {
      throw new CutoverUsageError("--gate needs --image <sha256:...>");
    }
    const certificates =
      options.certificate === ""
        ? loaded.certificates
        : [readCertificate(resolve(options.certificate))];
    const gate = evaluateCutoverGate({ image: options.image, certificates });
    if (options.json) printJson({ action: "gate", ...gate });
    else {
      process.stdout.write(
        `${reportLines("cutover gate", [
          gate.detail,
          ...gate.checks.map(
            (check) => `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`,
          ),
        ]).join("\n")}\n`,
      );
    }
    return gate.exitCode;
  }

  const now = options.now === "" ? new Date() : new Date(options.now);
  const recordPath = options.record === "" ? defaultRecordPath() : resolve(options.record);
  const record: MonthlyProductionRecord = existsSync(recordPath)
    ? parseMonthlyProductionRecord(readJson(recordPath))
    : monthlyProductionRecord();
  const monthly = evaluateMonthlyProduction({
    record,
    certificates: loaded.certificates,
    now,
    ...(options.image === "" ? {} : { image: options.image }),
  });
  if (options.json) printJson({ action: "monthly", ...monthly });
  else {
    process.stdout.write(
      `${reportLines(`monthly full production (${recordPath})`, [
        monthly.detail,
        ...monthly.checks.map(
          (check) => `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`,
        ),
      ]).join("\n")}\n`,
    );
  }
  return monthly.exitCode;
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
      if (error instanceof ReleaseError) {
        process.stderr.write(`demo:cutover: ${error.code}: ${error.message}\n`);
        process.exitCode = error.exitCode;
      } else if (error instanceof CertificateError) {
        process.stderr.write(`demo:cutover: ${error.code}: ${error.message}\n`);
        process.exitCode = error.exitCode;
      } else {
        process.stderr.write(`demo:cutover: ${(error as Error).message}\n`);
        process.exitCode = 2;
      }
    });
}
