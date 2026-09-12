import type { AgentConfig } from "./config";
import { getVoice } from "./voices";

/**
 * Compile an AgentConfig into the AssemblyAI `system_prompt` for a live call.
 *
 * This is not a generic "turn JSON into English" function. Every rule below was
 * paid for on a real phone call and is recorded in HANDOFF.md (1q), where the
 * caller's complaint was that the agent "sounds like a bot" — because the
 * prompt told it to be one. The fixes that followed, and why they're here:
 *
 *   - Brevity is stated FIRST. Everything after it is read in that light.
 *   - The agent is given an *identity*, not a behaviour checklist. Behaviour
 *     lists produce narrated compliance ("I will pass that along to our team").
 *   - Informality is granted explicitly, because safety training defaults
 *     models to stiff and they need permission to drop it.
 *   - Mirror the caller's length — the single most effective naturalness rule.
 *   - The banned-phrase list is the exact set of tells the agent emitted.
 *   - The comma self-check gives it a mechanical test it can actually apply.
 *
 * Keep this prompt SHORT. (1t) trimmed it 180 -> 113 words specifically to cut
 * prefill and shorten replies, and reply latency is the caller's top complaint.
 * Adding a paragraph here has a measurable cost at the far end of the phone.
 */
export function compileSystemPrompt(config: AgentConfig): string {
  const { identity } = config;
  const who = `${identity.name}, a ${identity.role}`;

  const sections: string[] = [
    // Front-loaded, per (1q). Do not move this below the identity.
    "Keep every reply short. One or two sentences. This is a phone call, not an essay.",
    `You are ${who}. ${config.mission}`,
    "Talk like a person, not a service desk. Contractions, plain words, the occasional incomplete sentence are all fine.",
    "Match the caller's length: short question, short answer.",
  ];

  if (config.detect.length > 0) {
    const fields = config.detect.map((d) => d.label).join(", ");
    sections.push(
      `Over the call, find out: ${fields}. Ask for these one at a time, woven into the conversation — never as a list.`,
    );
  }

  const sensitive = sensitiveCaptureFields(config);
  if (sensitive.length > 0) {
    sections.push(
      `Before asking for any of these fields, call prepare_sensitive_capture with its field key: ${sensitive.join(", ")}. Wait for the tool result, then ask the question. Never mention this pacing tool to the caller.`,
    );
  }

  if (config.knowledge.trim().length > 0) {
    sections.push(config.knowledge);
  }

  if (config.tools.length > 0) {
    sections.push(
      "Use your tools for every factual claim. If you do not have a tool result for something, say you will check rather than guessing.",
    );
  }

  // Language handling. The agent hears 18 languages but speaks 6, so a caller
  // can address it in one it cannot answer in — Arabic being the case that
  // matters most for the UAE launch. Left unsaid, the model tries to reply in
  // the caller's language and the TTS has no voice for it. Naming the spoken
  // language explicitly is what makes that mismatch graceful instead of broken.
  const voice = getVoice(config.voiceId);
  if (voice) {
    sections.push(
      `Speak ${voice.language}. If the caller uses another language, understand them and keep answering in ${voice.language} — do not apologise for it or comment on the language.`,
    );
  }

  // The banned list is verbatim from (1q) — these are the phrases this exact
  // stack produced on a real call, not a generic list of corporate-speak.
  sections.push(
    'Never say: "Thank you for that feedback", "I will pass that along", "I appreciate you sharing that", "As an AI". No preambles before answering.',
    "Before you speak, check: if your sentence has a comma, could it just stop at the comma? Usually it could.",
  );

  return sections.join("\n\n");
}

/**
 * Fields that need the endpointer relaxed while they're being captured.
 *
 * The bridge runs with `min_silence: 100` / `max_silence: 500` (HANDOFF 1t) to
 * buy back roughly a second of reply latency. The documented cost is that
 * adaptive pacing and entity-aware waiting are off for the whole session, so
 * the agent *will* cut a caller off partway through a phone number, budget or
 * date. Both fields are mutable mid-session; this is the list the bridge should
 * raise them for.
 */
export function sensitiveCaptureFields(config: AgentConfig): string[] {
  return config.detect.filter((d) => d.sensitive).map((d) => d.key);
}
