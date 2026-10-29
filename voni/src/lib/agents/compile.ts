import type { AgentConfig } from "./config";
import {
  assertPromptCarriesQualityFloor,
  composeAgentRules,
  qualityFloorFor,
} from "./quality-floor";
import { getVoice } from "./voices";

/**
 * Compile an AgentConfig into the AssemblyAI `system_prompt` for a live call.
 *
 * This is not a generic "turn JSON into English" function. Every rule below was
 * paid for on a real phone call and is recorded in HANDOFF.md (1q), where the
 * caller's complaint was that the agent "sounds like a bot" — because the
 * prompt told it to be one. The fixes that followed, and why they're here:
 *
 *   - The persona-neutral quality floor opens the prompt (ticket 67) in every
 *     Locale that has a rendering. Brevity is stated FIRST, and everything
 *     after it is read in that light.
 *   - The agent is given an *identity*, not a behaviour checklist. Behaviour
 *     lists produce narrated compliance ("I will pass that along to our team").
 *   - The floor owns brevity, the filler ban and steering in one place. This
 *     compiler no longer restates them: a second wording is how the two
 *     builders drifted, and how a guarantee became negotiable.
 *   - The comma self-check gives it a mechanical test it can actually apply.
 *
 * A tenant's mission and house rules ride on top of the floor; the demo's own
 * scenario rides on top through the same seam. Neither is forked into the
 * floor, and where a Locale has a rendering the floor is never optional — a
 * profile cannot remove it.
 *
 * Keep this prompt SHORT. (1t) trimmed it 180 -> 113 words specifically to cut
 * prefill and shorten replies, and reply latency is the caller's top complaint.
 * Adding a paragraph here has a measurable cost at the far end of the phone.
 */
export function compileSystemPrompt(config: AgentConfig): string {
  const { identity } = config;
  const who = `${identity.name}, a ${identity.role}`;
  // The prompt's Locale is the voice's (a voice speaks exactly one Locale).
  // Only a Locale that has rendered the floor carries it: until the per-Locale
  // renderings land (tickets 49/50) a non-English agent is a hole, never given
  // English rules. `null` is that hole; `undefined` never reaches this call.
  const voice = getVoice(config.voiceId);
  const floor = voice ? qualityFloorFor(voice.languageCode) : null;

  // Floor first, then identity before mission, then the persona's own rules.
  // `config.knowledge` is a tenant's house rules and, for the demo, the Demo
  // scenario: the caller of the builder decides which config this is, so the
  // scenario never reaches a tenant and is never copied into platform content.
  const sections: string[] = [
    composeAgentRules({
      floor,
      identity: `You are ${who}.`,
      mission: config.mission,
      houseRules: config.knowledge,
    }),
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

  if (config.tools.length > 0) {
    sections.push(
      "Use your tools for every factual claim. If you do not have a tool result for something, say you will check rather than guessing.",
    );
  }

  // Custom webhook tools arrive as `custom_<id>` voice tools; the prompt line
  // stays tool-agnostic so any user-added webhook is covered without a longer
  // prompt. The per-tool description (label + what it does) ships on the tool
  // definition itself, where the model reads it at call time.
  if ((config.customTools ?? []).length > 0) {
    sections.push(
      "Custom tools call an outside service and return its answer — wait for the result before acting on it.",
    );
  }

  // Interruption grace: the bridge only cuts audio on a confirmed
  // interruption, but the words still land mid-thought — and a sudden stop
  // mid-word reads as a glitch, not a human. Finish the current phrase, pivot
  // naturally, then follow. The acknowledgment belongs to the floor's steering
  // guarantee; the shape here (finish the phrase, never resume the cut-off
  // sentence) is not.
  sections.push(
    "If the caller steers mid-reply — a correction, no, stop, wait, hold on, repeat: finish your current phrase (never stop mid-word), then follow their new direction. Never talk over them, and never resume the cut-off sentence.",
  );

  // Call control: end_call is always available (built-in, not picked). The
  // execution layer refuses it while another tool is still running, and
  // post-call work queues as jobs — so the rule here is judgment only:
  // when the call is genuinely over, and the closing line comes first.
  // The tool is never NAMED here: with "call end_call" in the prose the
  // managed model wrote the call out as speech ("Bye! end_call(...)") in
  // 12 of 12 live hang-up evals; describing the act without the name
  // called the tool 6 of 6 (scripts/eval-demo-agent.mts). The tool's own
  // definition carries the name. "Hang up" stays on purpose, although the
  // glossary says End call for our own code and docs: this text is model
  // input, and the evals above were measured with this wording.
  sections.push(
    "Hang up only when the task is complete, the caller asks to end, consent is denied, or the conversation loops with no progress. Fire any follow-up tools first, speak a brief natural goodbye, then use your hang-up tool, and say nothing after it returns. Never narrate the mechanics — no 'the call has ended', 'I'm hanging up now'. The sound and the screen tell the caller. Never end mid-task.",
  );

  // Language handling. The agent hears 18 languages but speaks 6, so a caller
  // can address it in one it cannot answer in — Arabic being the case that
  // matters most for the UAE launch. Left unsaid, the model tries to reply in
  // the caller's language and the TTS has no voice for it. Naming the spoken
  // language explicitly is what makes that mismatch graceful instead of broken.
  if (voice) {
    sections.push(
      `Speak ${voice.language}. If the caller uses another language, understand them and keep answering in ${voice.language} — do not apologise for it or comment on the language.`,
    );
  }

  // One mechanical test for the floor's brevity, which is otherwise a
  // judgement: if the sentence could stop at its comma, let it.
  sections.push(
    "Before you speak, check: if your sentence has a comma, could it just stop at the comma? Usually it could.",
  );

  const prompt = sections.join("\n\n");
  // The floor is a guarantee on every body whose Locale has a rendering, not a
  // section a caller can drop: refuse a prompt that lost it, duplicated it, or
  // buried it below the identity. This is also what makes a hand-built body
  // fail loudly. A Locale with no rendering is already a hole above.
  if (floor) assertPromptCarriesQualityFloor(prompt, floor);
  return prompt;
}

/**
 * Fields that need the endpointer relaxed while they're being captured.
 *
 * The bridge runs with `min_silence: 100` / `max_silence: 1000` (balanced
 * voice-agent endpointing) to keep replies snappy. The documented cost is that
 * adaptive pacing and entity-aware waiting are off for the whole session, so
 * the agent *will* cut a caller off partway through a phone number, budget or
 * date. Both fields are mutable mid-session; this is the list the bridge should
 * raise them for.
 */
export function sensitiveCaptureFields(config: AgentConfig): string[] {
  return config.detect.filter((d) => d.sensitive).map((d) => d.key);
}
