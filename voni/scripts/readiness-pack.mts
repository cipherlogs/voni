/**
 * All-subject readiness pack CLI (meta-cascade M17, ticket 152).
 *
 *   npm run readiness:pack -- --manifest <path> [--tenants <path>] [--json] [--out <path>]
 *
 * Reads one manifest of subject evidence, verifies it through the readiness
 * modules (the one artifact reader, the run-history check and
 * `assembleCascadeReauditionPack`) and prints the pack: one row per subject with
 * both artifact paths and code fingerprints, the recorded W2 verdict, the
 * ballots and every named blocker.
 *
 * Read-only over evidence. It never writes or fabricates audio, never decides
 * accept/withdraw, and never marks ticket 152 resolved. `--out` writes only the
 * rendered report (markdown, or JSON with `--json`).
 *
 * Exit: 0 ready, 1 blocked, 2 bad input.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ReadinessManifestError,
  assembleReadinessPack,
  formatReadinessPack,
} from "../src/lib/demo/readiness-pack";

const USAGE = `Usage: npm run readiness:pack -- --manifest <path> [options]

  --manifest <path>   readiness manifest JSON (required)
  --tenants <path>    every subject eligible under routing=all: an array of
                      {subject, locale, transport?} or {subjects: [...]}
  --json              print the pack as JSON
  --out <path>        write the rendered report to a file (JSON with --json)
  --help              this text

Manifest contract (exactly these fields; see the module headers for detail):

  {
    "subjects": [{
      "subject": "lola",            // demo voice id, or tenant agent id
      "kind": "demo",               // "demo" | "tenant"
      "locale": "es",               // optional for demo (from the binding);
                                    //   required for a tenant
      "transport": "browser",       // optional; defaults to "browser"
      "artifacts": ["run-1.json", "run-2.json"],
                                    // the last two consecutive clean cascade
                                    //   artifact paths, oldest first
      "runsDir": "runs/lola",       // OR a directory of the subject's runs;
      "runHistory": ["run-1.json", "run-2.json"],
                                    // OR the complete ordered run history.
                                    //   Supply exactly one. The pair above must
                                    //   be the last two entries, in order; a
                                    //   clean or ineligible run after/between
                                    //   them blocks. No history = blocked as
                                    //   "last-two consecutive unverified".
      "reference": "lola-reference.wav",
      "delivered": "delivered-20261029.wav",
      "line": { "kind": "greeting", "text": "Hola, soy Lola." },
                                    // the W0 line marker; a segment uses
                                    //   {kind:"segment",text,startSeconds,endSeconds}
      "transcript": [               // text, or ordered {speaker,text}
        { "speaker": "agent", "text": "Hola, soy Lola." },
        { "speaker": "caller", "text": "Sí, claro." }
      ],
      "verdict": {                  // the OWNER's recorded statement, never ours
        "decision": "accept",       // "accept" | "withdraw" | "unresolved"
        "decidedOn": "2026-10-29",
        "reasons": "Why the content did or did not hold up."
      },
      "ballots": [                  // exactly two distinct raters, delivered sha
        { "reviewer": "ana", "reviewedOn": "2026-10-29",
          "recordingSha256": "<delivered sha256>",
          "scores": { "timbre": 5, "accent": 5, "languageNaturalness": 5 },
          "reason": "Clear, natural Spanish." }
      ]
    }],
    "deferrals": [{ "subject": "jorg", "date": "2026-10-30",
                    "reason": "German re-cast to jorg; W2 pack not recorded yet." }]
  }

The six demo voices are always required. A missing subject is a block, not an
omission; one failed subject blocks all. A dated deferral is refused when it is
duplicated, undated or unexplained, names a subject with recorded evidence, or
names a subject outside routing=all. A tenant row must match its --tenants
roster row on Locale and transport: evidence for another Locale/transport is
another subject and blocks, even when the artifact itself is clean.

Read-only. Missing/unreadable input exits 2; a blocked pack exits 1.`;

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function readJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(resolve(path), "utf8");
  } catch (error) {
    throw new ReadinessManifestError(
      `${label} ${path}: cannot read (${(error as Error).message})`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ReadinessManifestError(
      `${label} ${path}: is not JSON (${(error as Error).message})`,
    );
  }
}

function main(): number {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const manifestPath = arg("--manifest");
  if (!manifestPath) {
    throw new ReadinessManifestError("--manifest <path> is required (see --help)");
  }
  const tenantPath = arg("--tenants");
  const pack = assembleReadinessPack({
    manifest: readJson(manifestPath, "manifest"),
    ...(tenantPath ? { tenants: readJson(tenantPath, "--tenants") } : {}),
  });

  const asJson = process.argv.includes("--json");
  const output = asJson ? JSON.stringify(pack, null, 2) : formatReadinessPack(pack);
  const outPath = arg("--out");
  if (outPath) {
    writeFileSync(resolve(outPath), `${output}\n`);
    console.log(`readiness pack: ${pack.status} — wrote ${outPath}`);
  } else {
    console.log(output);
  }
  return pack.ready ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // Bad input (unreadable/invalid manifest or tenants) is exit 2; an unexpected
  // failure is also not a readiness verdict, so it never exits 0/1.
  process.exitCode = 2;
}
