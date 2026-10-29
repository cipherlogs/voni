/**
 * Agent-derived transcription aids: shared vocabulary + scene prompt for STT.
 *
 * Mirrors the copilot pattern (`@/lib/copilot/prompt.ts`): transcription
 * steering lives in one pure, unit-testable module, and every call path —
 * managed inline sessions, stored agents, the cascade pipeline — draws from
 * it so the demo a visitor hears and the product a customer deploys cannot
 * drift apart.
 *
 * Two channels by design (see the Voice Agent docs):
 * - system_prompt steers what the agent SAYS (see `../agents/compile.ts`).
 * - transcription_prompt + keyterms steer how the caller's speech is HEARD.
 *   Describe the call (scene, never instructions — behavioral commands like
 *   "use formal punctuation" are ignored).
 *
 * Voni is vertical-agnostic: a capable voice agent the customer connects to
 * any field. So NOTHING here names a vertical. Vocabulary comes from the
 * agent's own config — its name, the fields it listens for, the tools it
 * carries, and the owner's explicit "words to listen for" — plus a tiny
 * neutral fallback in the call's own Locale. Vertical flavor belongs to
 * templates and seed data (`REAL_ESTATE_TEMPLATE.keyterms`), never to
 * platform defaults.
 *
 * Budget: the recogniser takes ~100 terms. Prefer proper nouns the model
 * genuinely mishears; common words dilute the list and cause
 * overcorrections. Iterate from real misses in session timelines
 * (`telephony-bot/pull_session.py`), not by guessing.
 */

import type { AgentConfig } from "@/lib/agents/config";
import {
  EN_RECOGNITION,
  callRecognitionLocale,
  recognitionVocabulary,
  type RecognitionLocale,
} from "@/lib/voice/recognition";

/**
 * The transcription mode for every call surface. `balanced` is the API's
 * voice-agent default; `max_accuracy` waits longest to confirm the end of a
 * turn. Reply speed rides mostly on never sending turn_detection
 * (ADAPTIVE_TURNS in ./session.ts).
 */
export const TRANSCRIPTION_MODE = "balanced";

/**
 * Demo + test-call: balanced is the voice-agent default and keeps the reply
 * gap in the fast band (max_accuracy's endpointing wait added ~0.5-0.7s).
 * Entity-aware endpointing still holds tags, addresses and numbers together.
 */
export const DEMO_TRANSCRIPTION_MODE = "balanced";

/**
 * Words a call hears correctly without asking, in the automatic-detection
 * case: the product name and the channels it answers on. This is the one
 * documented English-scaffolding exception — automatic detection cannot know
 * the Locale before the caller speaks, so the neutral English fallback primes
 * it. A pinned Locale never uses this list; it uses its own vocabulary.
 */
export const NEUTRAL_KEYTERMS: string[] = [...EN_RECOGNITION.vocabulary];

/**
 * The neutral terms a call is primed with, in the call's own Locale.
 *
 * `null` is automatic detection (see `NEUTRAL_KEYTERMS`). A Locale with no
 * vocabulary rendering contributes nothing: the hole is not filled from
 * English, because English words in a Spanish request teach the recogniser the
 * wrong language.
 */
export function neutralKeytermsFor(locale: RecognitionLocale | null): readonly string[] {
  if (locale === null) return NEUTRAL_KEYTERMS;
  return recognitionVocabulary(locale) ?? [];
}

/**
 * Recognition nouns contributed by each built-in tool, keyed by tool name.
 * Only tools the agent actually enables contribute — a dental agent without
 * property tools never hears property nouns. One line per tool; keep to
 * nouns callers say, not verbs the agent does.
 */
const TOOL_NOUN_HINTS: Record<string, string[]> = {
  search_properties: ["property", "apartment", "villa", "townhouse"],
  get_property_details: ["property", "listing"],
  check_availability: ["available", "availability"],
  check_calendar: ["calendar", "appointment", "slot"],
  book_viewing: ["viewing", "booking", "visit"],
  schedule_follow_up: ["follow-up", "callback"],
  update_lead: ["budget", "timeline"],
  transfer_to_human: ["manager", "supervisor", "human", "person"],
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "their", "they", "them", "that",
  "this", "from", "about", "into", "over", "under", "what", "when",
  "whether", "which", "while", "how", "are", "you", "can", "has",
]);

/** Split a label into candidate keyterms: words ≥3 letters, no stopwords. */
function wordsOf(label: string): string[] {
  return label
    .split(/[^A-Za-zÀ-ÿ'’-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word.toLowerCase()));
}

/**
 * Per-agent vocabulary: the Locale's neutral fallback + the agent's spoken
 * name, the fields it listens for, nouns from its enabled tools and custom-tool
 * labels, and the owner's explicit list. Capped at 100, deduped.
 *
 * `locale` defaults to the call's own Locale (`callRecognitionLocale`). The
 * built-in tool nouns are English platform scaffolding, so they prime an
 * English or automatic-detection call only; a pinned non-English Locale hears
 * its own vocabulary and the owner's own config, never a platform English noun.
 * Owner keyterms are the owner's whatever their language.
 */
export function buildAgentKeyterms(
  config: AgentConfig,
  locale: RecognitionLocale | null = callRecognitionLocale(config),
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (term: string) => {
    const clean = term.trim().replace(/\s+/g, " ");
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };
  for (const term of neutralKeytermsFor(locale)) push(term);
  push(config.identity.name);
  for (const field of config.detect ?? []) {
    for (const word of wordsOf(field.label)) push(word);
  }
  if (locale === null || locale === "en") {
    for (const name of config.tools ?? []) {
      for (const noun of TOOL_NOUN_HINTS[name] ?? []) push(noun);
    }
  }
  for (const tool of config.customTools ?? []) {
    for (const word of wordsOf(tool.label)) push(word);
  }
  for (const term of config.keyterms ?? []) push(term);
  return out.slice(0, 100);
}

/** Scene description for speech recognition, derived from the agent's own mission and role. */
export function buildAgentTranscriptionPrompt(config: AgentConfig): string {
  const { identity, mission } = config;
  const topics = (config.detect ?? [])
    .map((field) => field.label.trim())
    .filter(Boolean)
    .slice(0, 8);
  const scene = EN_RECOGNITION.scene({
    agentName: identity.name,
    role: identity.role,
    mission,
    topics,
  });
  // The prompt rides inside session payloads with a ~1500-char context
  // budget shared with agent_context — stay far under it.
  return scene.slice(0, 500);
}
