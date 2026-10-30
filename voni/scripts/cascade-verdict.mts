/**
 * W2 cascade owner verdict — record the owner's statement about one cascade
 * re-audition pack (meta-cascade M16, ticket 134).
 *
 *   npm run voice:cascade-verdict -- \
 *     --pack reaudition-runs/lola-es-cascade/pack/pack.json \
 *     --decision accept \
 *     --reviewer "Owner Name" \
 *     --capture .captures/delivered-<stamp>.wav \
 *     --reason "The second Spanish sentence stalls and ends mid-clause." \
 *     --adr
 *
 * ── Why it exists ─────────────────────────────────────────────────────────
 * The pack (ticket 133) assembles the inputs and never decides. Ticket 134
 * needs the owner's ear recorded with a date and written reasons, separate
 * from the two ballots. This script is the only writer of that record: it
 * names the human and the delivered capture, hashes the named WAV so it must be
 * the pack's recording, and refuses accept/withdraw on an incomplete pack or a
 * missing ballot. An unresolved verdict is recordable and blocks the Locale.
 *
 * It never invents a verdict, a reviewer or a reason. Run it only after you
 * have listened to the delivered capture.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CascadeReauditionPack } from "../src/lib/demo/cascade-reaudition";
import {
  applyCascadeVerdictToAdr,
  CASCADE_OWNER_DECISIONS,
  CascadeVerdictError,
  formatCascadeVerdictSection,
  recordCascadeOwnerVerdict,
  type CascadeOwnerDecision,
} from "../src/lib/demo/cascade-verdict";

const VONI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(VONI_DIR, "..");
const DEFAULT_ADR = join(ROOT, "docs/adr/0008-english-is-one-rendering-not-the-source.md");

const USAGE = `Usage: npm run voice:cascade-verdict -- --pack <pack.json> --decision <accept|withdraw|unresolved>

Required:
  --pack <file>        the cascade re-audition pack from ticket 133
  --decision <value>   accept | withdraw | unresolved (ADR 0008 meanings)
  --reviewer <name>    the human whose ear made the verdict
  --reason <text>      a written reason; repeat for more than one

The capture (required for accept/withdraw):
  --capture <file.wav> the delivered capture that was heard; its sha256 must
                       match the pack's delivered capture
  --sha256 <hex>       with no --capture, record a known hash (unresolved only)

Output:
  --out <file>         where to write verdict.json (default: beside the pack)
  --adr [path]         write the section into the decision record (default: ADR 0008)
  --print-adr          print the section instead of writing it
  --json               print the verdict record

Accept means the content did not hold up and the per-locale rendering layer is
justified. Withdraw means it held up and the layer is not justified to fix
quality. Unresolved means the pack cannot decide; it blocks the Locale and is
never a pass.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

/** Every `--reason "…"`, in the order given. */
function repeated(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((token, index) => {
    if (token !== name) return;
    const value = process.argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) values.push(value);
  });
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPack(path: string): CascadeReauditionPack {
  if (!existsSync(path)) throw new Error(`--pack ${path} does not exist`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error(`--pack ${path} is not a JSON object`);
  if (raw.kind !== "cascade-reaudition-pack") {
    throw new Error(
      `--pack ${path} is not a cascade re-audition pack (kind ${String(raw.kind)}); a managed pack does not carry over`,
    );
  }
  if (String(raw.schemaVersion) !== "1") {
    throw new Error(`--pack ${path} has schema version ${String(raw.schemaVersion)}, expected 1`);
  }
  const pack = raw as unknown as CascadeReauditionPack;
  if (!isRecord(pack.captures) || !isRecord(pack.captures.delivered)) {
    throw new Error(`--pack ${path} carries no captures.delivered block`);
  }
  if (!isRecord(pack.ballots) || !isRecord(pack.verdict)) {
    throw new Error(`--pack ${path} is missing its ballots or its verdict block`);
  }
  return pack;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main(): void {
  if (flag("--help") || process.argv.length <= 2) {
    console.log(USAGE);
    return;
  }

  const packPath = arg("--pack");
  if (!packPath) throw new Error(`--pack is required\n\n${USAGE}`);
  const packFile = resolve(packPath);
  const pack = readPack(packFile);

  const decision = arg("--decision");
  if (!decision || !(CASCADE_OWNER_DECISIONS as readonly string[]).includes(decision)) {
    throw new Error(`--decision must be one of ${CASCADE_OWNER_DECISIONS.join(", ")}\n\n${USAGE}`);
  }

  const reviewer = arg("--reviewer");
  if (!reviewer) throw new Error(`--reviewer is required: an unnamed check is not a verdict\n\n${USAGE}`);

  const reasons = repeated("--reason");
  if (reasons.length === 0) throw new Error(`--reason is required\n\n${USAGE}`);

  const captureArg = arg("--capture");
  if (!captureArg && decision !== "unresolved") {
    throw new Error(`--capture is required for ${decision}: name the delivered capture you heard\n\n${USAGE}`);
  }
  const captureFile = captureArg ? resolve(captureArg) : null;
  let captureSha = arg("--sha256") ?? "";
  if (captureFile === null && captureSha !== "" && decision !== "unresolved") {
    throw new Error(
      `--sha256 without --capture is only allowed for an unresolved verdict: a decision must name the recording it judged`,
    );
  }
  if (captureFile !== null) {
    if (!existsSync(captureFile)) {
      throw new Error(`--capture ${captureFile} does not exist; name the capture that was heard`);
    }
    const fromFile = sha256File(captureFile);
    if (captureSha !== "" && captureSha !== fromFile) {
      throw new Error(
        `--sha256 ${captureSha} is not the hash of --capture ${captureFile} (${fromFile}); the named capture is ambiguous`,
      );
    }
    captureSha = fromFile;
  }

  const record = recordCascadeOwnerVerdict(
    pack,
    {
      decision: decision as CascadeOwnerDecision,
      decidedOn: arg("--date") ?? new Date().toISOString().slice(0, 10),
      reviewer,
      capture: { path: captureFile, sha256: captureSha },
      reasons,
    },
    packFile,
  );

  const outPath = resolve(arg("--out") ?? join(dirname(packFile), "verdict.json"));
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);

  if (flag("--json")) {
    console.log(JSON.stringify(record, null, 2));
  } else {
    console.log(`verdict recorded: ${record.decision} — ${record.decidedOn}`);
    console.log(`  reviewer: ${record.reviewer}`);
    console.log(`  capture:  ${record.capture.path} (${record.capture.sha256 || "unrecorded"})`);
    console.log(`  record:   ${outPath}`);
    if (record.blocksLocale) {
      console.log(`  locale ${record.subject.locale} is blocked: an unresolved pack is not a pass`);
    }
  }

  const adr = arg("--adr") ?? (flag("--adr") ? DEFAULT_ADR : undefined);
  if (adr) {
    const adrPath = resolve(adr);
    writeFileSync(adrPath, applyCascadeVerdictToAdr(readFileSync(adrPath, "utf8"), record));
    console.log(`decision record updated: ${adrPath}`);
  } else if (flag("--print-adr")) {
    console.log(formatCascadeVerdictSection(record));
  } else {
    console.log(
      `no decision record written: pass --adr to write ${DEFAULT_ADR.replace(`${ROOT}/`, "")}; the verdict currently lives only in ${outPath}`,
    );
  }
}

try {
  main();
} catch (error) {
  if (error instanceof CascadeVerdictError) {
    console.error(`cascade verdict refused: ${error.blockers.join("\n  - ")}`);
  } else {
    console.error(`cascade verdict failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
