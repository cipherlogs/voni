/**
 * Export the app voice catalogue as JSON (ticket 130).
 *
 * The German voice probe is Python, but the catalogue is TypeScript. Rather
 * than keep a second hand parser of `voices.ts`, the probe reads this export:
 *
 *   cd voni && npm run voice:catalogue > /tmp/voice-catalogue.json
 *   cd ../voice-pipeline && python scripts/probe_voices.py --catalogue-de /tmp/voice-catalogue.json
 *
 * Only the fields the probe needs are exported; the file is a projection of
 * `VOICES`, never a second catalogue.
 */
import { VOICES } from "../src/lib/agents/voices";

export const VOICE_CATALOGUE_SCHEMA_VERSION = 1;

export function voiceCatalogueDocument() {
  return {
    schemaVersion: VOICE_CATALOGUE_SCHEMA_VERSION,
    source: "src/lib/agents/voices.ts",
    voices: VOICES.map((voice) => ({
      id: voice.id,
      language: voice.language,
      languageCode: voice.languageCode,
    })),
  };
}

console.log(JSON.stringify(voiceCatalogueDocument(), null, 2));
