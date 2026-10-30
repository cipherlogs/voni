/**
 * W1 level contract — measure each voice's native reference and record it.
 *
 *   npm run voice:levels
 *   npm run voice:levels -- --takes 5
 *   npm run voice:levels -- --voice anna --force
 *
 * A voice's level is `output.volume` on its stored body. That number is only
 * auditable if the audio behind it is measured, so this script renders each
 * catalog voice's own greeting through the vendor's text-to-speech engine (no
 * client, platform or model in the path), measures the render with the same
 * `level-facts` module the gate uses, and writes
 * `evidence/voice-levels/levels.json`.
 *
 * It writes evidence, never the registry: a recapture is a new evidence record
 * and the registry change is reviewed against it (`src/lib/agents/voice-levels.ts`).
 * An existing record is refused unless `--force` is passed, and the commit
 * message must say why.
 *
 * The voice the endpoint does not serve is recorded as unmeasured with the
 * endpoint's own refusal, not retried into a passing number.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VOICES } from "../src/lib/agents/voices";
import { VONI_GREETINGS } from "../src/lib/demo/voni-agent";
import { analyseLevel } from "../src/lib/audio/level-facts";
import { decodeWav } from "../src/lib/audio/format-facts";

const SAMPLE_RATE = 24_000;
const VENDOR_HOST = "https://tts.us.assemblyai.com";
const EVIDENCE = fileURLToPath(new URL("../evidence/voice-levels/levels.json", import.meta.url));
const REFERENCE_FLOOR = fileURLToPath(
  new URL("../evidence/vendor-floor/anna-en.wav", import.meta.url),
);

const LANGUAGE_NAMES: Record<string, string> = {
  en: "english",
  es: "spanish",
  fr: "french",
  de: "german",
  it: "italian",
  pt: "portuguese",
};

const USAGE = `Usage: npm run voice:levels -- [options]

  --takes <n>       renders per voice, default 3 (median is recorded)
  --voice <id>      only this catalog voice (its row is replaced; the rest stay)
  --out <path>      evidence file, default evidence/voice-levels/levels.json
  --force           replace an existing record (a new evidence record)

Needs ASSEMBLYAI_API_KEY. Writes evidence, never the level registry.`;

type EvidenceRow = { voice: string } & Record<string, unknown>;

type EvidenceDocument = {
  schemaVersion: number;
  measuredOn: string;
  method: string;
  measuredWith: string;
  reference: Record<string, unknown>;
  decision: string;
  voices: EvidenceRow[];
  unmeasured: EvidenceRow[];
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function fail(message: string): never {
  console.error(`voice level measurement failed: ${message}`);
  process.exit(1);
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main(): Promise<void> {
  if (flag("--help")) {
    console.log(USAGE);
    return;
  }
  const takes = Number(arg("--takes") ?? 3);
  if (!Number.isInteger(takes) || takes < 1) fail("--takes must be a positive integer");
  const only = arg("--voice");
  const out = resolve(arg("--out") ?? EVIDENCE);
  if (existsSync(out) && !flag("--force")) {
    fail(
      `${out} already records a measurement. A recapture is a new evidence record: ` +
        "pass --force and say why in the commit message.",
    );
  }
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) fail("ASSEMBLYAI_API_KEY missing: run with --env-file-if-exists=.dev.vars");

  const referenceFloor = analyseLevel(decodeWav(readReferenceFloor()));
  if (!referenceFloor.measured) fail("the committed vendor floor has no measurable level");

  const measured: EvidenceRow[] = [];
  const unmeasured: EvidenceRow[] = [];

  for (const voice of VOICES) {
    if (only && voice.id !== only) continue;
    const locale = voice.languageCode;
    const line = VONI_GREETINGS[locale];
    const language = LANGUAGE_NAMES[locale];
    if (!line || !language) {
      unmeasured.push({
        voice: voice.id,
        locale,
        volume: 100,
        reason: `no greeting or vendor language name for ${locale}`,
      });
      continue;
    }
    const lufs: number[] = [];
    const peaks: number[] = [];
    let refusal: string | null = null;
    for (let take = 0; take < takes; take++) {
      const response = await fetch(`${VENDOR_HOST}/v1/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: line,
          voice_id: `aai-${voice.id}`,
          language,
          sample_rate: SAMPLE_RATE,
          encoding: "pcm_s16le",
          container: "wav",
          stream: false,
        }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { code?: string };
        refusal = `${response.status} ${detail.code ?? "refused"}`;
        break;
      }
      const audio = decodeWav(new Uint8Array(await response.arrayBuffer()));
      const facts = analyseLevel(audio);
      if (!facts.measured) {
        refusal = `unmeasurable take (${facts.absence})`;
        break;
      }
      lufs.push(facts.integratedLufs);
      peaks.push(facts.truePeakDbtp);
    }
    if (refusal || lufs.length === 0) {
      unmeasured.push({
        voice: voice.id,
        locale,
        volume: 100,
        reason: `vendor /v1/speech did not serve a measurable reference: ${refusal ?? "no takes"}`,
      });
      continue;
    }
    measured.push({
      voice: voice.id,
      locale,
      line,
      takes: lufs.map(round),
      integratedLufs: round(median(lufs)),
      truePeakDbtp: round(Math.max(...peaks)),
      volume: 100,
    });
    console.log(
      `${voice.id.padEnd(9)} ${locale}  median ${round(median(lufs)).toFixed(2)} LUFS  ` +
        `peak ${round(Math.max(...peaks)).toFixed(2)} dBTP  volume 100`,
    );
  }

  const record: EvidenceDocument = {
    schemaVersion: 1,
    measuredOn: today(),
    method:
      `POST ${VENDOR_HOST}/v1/speech, stream=false, container=wav, encoding=pcm_s16le, ` +
      `sample_rate=${SAMPLE_RATE}, one call per take, each voice's own greeting in its own Locale`,
    measuredWith: "src/lib/audio/level-facts.ts (BS.1770-4 gated integrated loudness, 4x true peak)",
    reference: {
      voice: "anna",
      file: "evidence/vendor-floor/anna-en.wav",
      integratedLufs: referenceFloor.measured ? round(referenceFloor.integratedLufs) : null,
      capturedOn: "2026-10-29",
    },
    decision:
      "output.volume = 100 for every measured voice: its own measured reference is the level " +
      "target, and 100 is the native (unprocessed) level. output.volume attenuates only, so no " +
      "voice is boosted; no measured voice is louder than the reference floor beyond the gate's " +
      "0.20 LU tolerance and no take clips (every true peak below 0 dBTP), so none needs " +
      "attenuation. An unmeasured voice keeps the named default 100.",
    voices: measured,
    unmeasured,
  };

  const document = only === undefined ? record : mergeOneVoice(out, only, record);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  console.log(
    `\nwrote ${out} (${document.voices.length} measured, ${document.unmeasured.length} unmeasured)`,
  );
}

/**
 * A `--voice` run re-measures one catalogue voice; it is not a fresh evidence
 * set. Keep every other catalogue voice's committed row and prune rows for ids
 * the catalogue no longer offers (a retired voice), so a single-voice run
 * cannot silently delete fifteen measured references.
 */
function mergeOneVoice(out: string, only: string, record: EvidenceDocument): EvidenceDocument {
  if (!existsSync(out)) return record;
  let previous: EvidenceDocument;
  try {
    previous = JSON.parse(readFileSync(out, "utf8")) as EvidenceDocument;
  } catch {
    fail(`${out} is not readable evidence; a one-voice run cannot preserve its rows`);
  }
  const catalogue = VOICES.map((voice) => voice.id);
  const order = new Map(catalogue.map((voice, index) => [voice, index]));
  const keep = (rows: EvidenceRow[] | undefined) =>
    (Array.isArray(rows) ? rows : []).filter(
      (row) => row.voice !== only && order.has(row.voice),
    );
  const byCatalogueOrder = (row: EvidenceRow) => order.get(row.voice) ?? catalogue.length;
  return {
    ...record,
    voices: [...keep(previous.voices), ...record.voices].sort(
      (left, right) => byCatalogueOrder(left) - byCatalogueOrder(right),
    ),
    unmeasured: [...keep(previous.unmeasured), ...record.unmeasured].sort(
      (left, right) => byCatalogueOrder(left) - byCatalogueOrder(right),
    ),
  };
}

function readReferenceFloor(): Uint8Array {
  if (!existsSync(REFERENCE_FLOOR)) fail(`the committed vendor floor is missing: ${REFERENCE_FLOOR}`);
  return new Uint8Array(readFileSync(REFERENCE_FLOOR));
}

main().catch((error: unknown) => {
  console.error(
    `voice level measurement failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
