/**
 * W0 reference capture — render one line in one voice outside a conversation.
 *
 * The reference is the first of the three captures a call is judged against
 * (reference, platform recording, delivered audio). It comes from the same
 * silent-greeting session the scoreboard uses for callers: a session told to
 * stay silent, with the line as its greeting, so the audio is the voice and
 * the text with no model and no conversation around it.
 *
 *   npm run voice:reference -- --voice lola
 *   npm run voice:reference -- --voice lola --text "Probemos otra frase."
 *   npm run voice:reference -- --voice lola --text-file bad-line.txt
 *   npm run voice:reference -- --voice anna --out-dir /tmp/refs
 *
 * The default line is the voice's own greeting in its own Locale. A text file
 * renders a mid-call sentence as its own reference, so a bad line is not
 * blamed on the greeting. The file is cached by voice AND text under
 * `.voice-references/` (gitignored working files, never committed), so a rerun
 * is free and a changed line is a new capture. It is a standard PCM WAV at the
 * voice's native level: no client gain, no limiter, no normalisation.
 */
import { fileURLToPath } from "node:url";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";
import {
  REFERENCE_SAMPLE_RATE,
  referenceDurationMs,
  renderReference,
} from "../src/lib/demo/reference-render";
import { collectSilentGreeting } from "../src/lib/voice/silent-greeting";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function optionalArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const apiKey = process.env.ASSEMBLYAI_API_KEY;

async function token(): Promise<string> {
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY missing: run with --env-file=.dev.vars");
  const url = new URL("https://agents.assemblyai.com/v1/token");
  url.searchParams.set("expires_in_seconds", "60");
  url.searchParams.set("max_session_duration_seconds", "60");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

/** One token per run: a cache hit never fetches one at all. */
let sessionToken: string | null = null;

async function main(): Promise<void> {
  const voiceId = arg("--voice", DEMO_VOICE_IDS[0]);
  const text = optionalArg("--text");
  const textFile = optionalArg("--text-file");
  const dir = arg("--out-dir", fileURLToPath(new URL("../.voice-references/", import.meta.url)));

  const rendered = await renderReference({
    voiceId,
    ...(text === undefined ? {} : { text }),
    ...(textFile === undefined ? {} : { textFile }),
    dir,
    synth: async ({ voiceId: voice, text: line }) => {
      sessionToken ??= await token();
      return collectSilentGreeting({ voiceId: voice, text: line, token: sessionToken });
    },
  });

  console.log(
    `reference ${rendered.cached ? "cached" : "rendered"}: ${rendered.path} (${Math.round(rendered.bytes / 1024)} KiB)`,
  );
  console.log(
    `  ${rendered.voiceId}, ${REFERENCE_SAMPLE_RATE} Hz mono PCM16, ` +
      `${referenceDurationMs(rendered.path)} ms, native level (no gain, no limiter)`,
  );
  console.log(`  line "${rendered.text}"`);
}

main().catch((error: unknown) => {
  console.error(`reference capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
