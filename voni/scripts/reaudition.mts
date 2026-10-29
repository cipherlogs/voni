/**
 * W2 re-audition — assemble the evidence pack and write the automated verdict
 * into the locale-rendering decision record.
 *
 *   npm run voice:reaudition -- --voice lola --locale es --pending --out reaudition-runs/lola-es
 *   npm run voice:reaudition -- --voice lola --locale es \
 *     --transcript reaudition-runs/lola-es/platform.json \
 *     --reference reaudition-runs/lola-es/reference/<rendered>.wav \
 *     --platform reaudition-runs/lola-es/platform/sess_<id>-agent-<rate>hz.wav \
 *     --delivered .captures/delivered-<stamp>.wav \
 *     --session sess_<id> \
 *     --out reaudition-runs/lola-es/pack \
 *     --adr ../docs/adr/0008-english-is-one-rendering-not-the-source.md
 *
 * The three captures are required for a complete pack. The transcript can be
 * the QA evidence JSON (`timeline.transcripts`), a `{turns}` JSON, or labelled
 * text. The content judge runs through the repo's existing generateJSON client;
 * `--judge-evidence` replays a recorded judgement offline and `--skip-judge`
 * assembles the pack without one. No live call is placed here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getVoice } from "../src/lib/agents/voices";
import { CAPTURE_ROLES, type CaptureRole } from "../src/lib/audio/comparison";
import {
  applyReauditionToAdr,
  assembleReauditionPack,
  assertReauditionComplete,
  formatDecisionRecordSection,
  formatReauditionSummary,
} from "../src/lib/demo/reaudition";
import { VONI_GREETINGS } from "../src/lib/demo/voni-agent";
import {
  judgeContent,
  scoreContent,
  type ContentBaseline,
  type ContentJudgeEvidence,
  type ContentJudgement,
  type ContentTurn,
} from "../src/lib/voice/content-judge";

const VONI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(VONI_DIR, "..");
const DEFAULT_ADR = join(ROOT, "docs/adr/0008-english-is-one-rendering-not-the-source.md");

const USAGE = `Usage: npm run voice:reaudition -- --voice <id> --locale <code> [captures]

Required:
  --voice <id>            demo voice id (lola, giovanni, rafael, ...)
  --locale <code>         target Locale; derived from the voice when omitted

Live evidence (all three make the pack complete):
  --reference <file.wav>  rendering of the greeting outside a conversation
  --platform  <file.wav>  the agent channel from qa:voice-session --keep-audio
  --delivered <file.wav>  the WAV the browser wrote with ?delivercapture=1
  --transcript <path>     QA evidence JSON, {turns} JSON, or labelled text
  --session <sess_...>    the live session id

Content judgement:
  --judge-evidence <json> replay a recorded ContentJudgeEvidence (offline)
  --skip-judge            assemble without a judgement (the verdict stays unresolved)

Output:
  --out <dir>             pack directory (default reaudition-runs/<voice>-<locale>-<stamp>)
  --adr [path]           write the verdict section (default: ADR 0008)
  --pending               emit a template marked pending-live-call
  --require-complete      exit 1 unless the pack can produce a decision
  --json                  print the pack JSON instead of the human summary

A missing capture is never a pass: the pack is written as incomplete and the
verdict is unresolved.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function speakerOf(value: unknown): "agent" | "caller" {
  const speaker = String(value ?? "").trim().toLowerCase();
  if (speaker === "agent" || speaker === "assistant" || speaker === "voni") return "agent";
  if (speaker === "caller" || speaker === "user" || speaker === "visitor") return "caller";
  throw new Error(`transcript turn has an unknown speaker "${String(value)}"`);
}

function turnsFromJson(value: unknown): ContentTurn[] {
  if (!Array.isArray(value)) throw new Error("transcript turns must be an array");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.text !== "string") {
      throw new Error("each transcript turn needs a speaker and text");
    }
    return { speaker: speakerOf(entry.speaker), text: entry.text };
  });
}

/**
 * QA evidence carries one entry per platform turn with `user` and `agent`
 * fields; keep the call order (caller then agent) so turn indices line up.
 */
function turnsFromQa(transcripts: unknown[]): ContentTurn[] {
  const turns: ContentTurn[] = [];
  for (const entry of transcripts) {
    if (!isRecord(entry)) continue;
    if (typeof entry.user === "string" && entry.user.trim()) {
      turns.push({ speaker: "caller", text: entry.user });
    }
    if (typeof entry.agent === "string" && entry.agent.trim()) {
      turns.push({ speaker: "agent", text: entry.agent });
    }
  }
  return turns;
}

function readTranscript(path: string | undefined): ContentTurn[] {
  if (!path) return [];
  const text = readFileSync(resolve(path), "utf8");
  if (path.endsWith(".json")) {
    const data = JSON.parse(text) as unknown;
    if (isRecord(data) && isRecord(data.timeline) && Array.isArray(data.timeline.transcripts)) {
      return turnsFromQa(data.timeline.transcripts);
    }
    if (Array.isArray(data)) return turnsFromJson(data);
    if (isRecord(data) && Array.isArray(data.turns)) return turnsFromJson(data.turns);
    throw new Error("transcript JSON has no timeline.transcripts or turns array");
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const labelled = lines.length > 0 && lines.every((line) => /^(agent|assistant|voni|caller|user|visitor)\s*:/i.test(line));
  if (labelled) {
    return lines.map((line) => {
      const colon = line.indexOf(":");
      return { speaker: speakerOf(line.slice(0, colon)), text: line.slice(colon + 1).trim() };
    });
  }
  return text.trim() ? [{ speaker: "agent", text: text.trim() }] : [];
}

function capturesFromArgs(): Partial<Record<CaptureRole, string>> {
  const captures: Partial<Record<CaptureRole, string>> = {};
  for (const role of CAPTURE_ROLES) {
    const value = arg(`--${role}`);
    if (value) captures[role] = value;
  }
  return captures;
}

async function judge(args: {
  locale: string;
  baseline: ContentBaseline;
  transcript: ContentTurn[];
}): Promise<ContentJudgement | null> {
  if (flag("--skip-judge") || flag("--pending")) return null;
  const evidencePath = arg("--judge-evidence");
  if (evidencePath) {
    const evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8")) as ContentJudgeEvidence;
    return scoreContent(
      { locale: args.locale, baseline: args.baseline, transcript: args.transcript },
      evidence,
    );
  }
  return judgeContent({
    locale: args.locale,
    baseline: args.baseline,
    transcript: args.transcript,
  });
}

async function main(): Promise<void> {
  if (flag("--help") || flag("-h")) {
    console.log(USAGE);
    return;
  }

  const voiceId = arg("--voice");
  if (!voiceId) throw new Error(`--voice is required\n\n${USAGE}`);
  const voice = getVoice(voiceId);
  if (!voice) throw new Error(`unknown voice "${voiceId}"; use a demo voice id`);

  const locale = arg("--locale") ?? voice.languageCode;
  if (!locale) throw new Error("--locale is required when the voice has no Locale");
  const baseline: ContentBaseline = {
    locale: "en",
    text: arg("--baseline-text") ?? VONI_GREETINGS.en ?? "",
  };

  const pending = flag("--pending");
  const transcript = readTranscript(arg("--transcript"));
  let judgement: ContentJudgement | null = null;
  let judgeError: string | null = null;
  try {
    judgement = await judge({ locale, baseline, transcript });
  } catch (error) {
    judgeError = error instanceof Error ? error.message : String(error);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const outDir = resolve(arg("--out") ?? join(VONI_DIR, "reaudition-runs", `${voiceId}-${locale}-${stamp}`));
  const result = assembleReauditionPack({
    voice: voiceId,
    locale,
    baseline,
    transcript,
    judgement,
    captures: pending ? {} : capturesFromArgs(),
    outDir,
    sessionId: arg("--session") ?? null,
    pending,
    root: ROOT,
  });

  if (flag("--json")) {
    console.log(JSON.stringify(result.pack, null, 2));
  } else {
    console.log(formatReauditionSummary(result.pack));
    console.log(`  pack: ${result.packPath}`);
    console.log(`  readme: ${result.readmePath}`);
    if (judgeError) console.error(`content judge failed: ${judgeError}`);
    if (result.pack.operator) {
      console.log("");
      console.log("Operator steps:");
      for (const step of result.pack.operator.steps) console.log(`  - ${step}`);
    }
  }

  const adr = arg("--adr") ?? (flag("--adr") ? DEFAULT_ADR : undefined);
  if (adr) {
    const adrPath = resolve(adr);
    const updated = applyReauditionToAdr(readFileSync(adrPath, "utf8"), result.pack);
    writeFileSync(adrPath, updated);
    console.log(`decision record updated: ${adrPath}`);
  } else if (flag("--print-adr")) {
    console.log(formatDecisionRecordSection(result.pack));
  }

  if (flag("--require-complete")) {
    assertReauditionComplete(result.pack);
  } else if (judgeError && !pending) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`re-audition failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
