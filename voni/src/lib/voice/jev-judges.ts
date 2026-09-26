/**
 * Jev fast-judge client for the browser test call.
 *
 * Role split:
 * - The pure helpers below (`shouldYieldToBargeIn`, `chooseReplyAction`,
 *   `shouldAllowToolCall`) are the offline/heuristic fallback. They run in
 *   <1ms, never touch the network, and encode the fail-closed rule the user
 *   picked: when unsure, the agent finishes instead of cutting itself off.
 * - `requestVoiceJudge` asks the server route (`/api/voice-judge`, which owns
 *   the gateway key) for a Jev probability. It always resolves — timeouts and
 *   errors fall back to the heuristic with `source: "fallback"`.
 *
 * Never call this in the per-frame audio loop. Call sites are discrete voice
 * events: `onUserPartial` (barge-in), settled final transcript (reply/filler),
 * and proposed tool calls (verify-before-apply).
 */

export const BARGE_IN_THRESHOLD = 0.65;
export const REPLY_NOW_THRESHOLD = 0.6;
export const FILLER_THRESHOLD = 0.6;
/** Off-track leans lenient: a false strike on a real visitor costs a Prospect. */
export const OFF_TRACK_THRESHOLD = 0.6;
/** Budget per judgment; the audio path must never wait on the network. */
export const JUDGE_TIMEOUT_MS = 120;

export const FILLER_POOL = [
  "Got it — pulling that up…",
  "One sec…",
  "Let me check that for you…",
] as const;

export type BargeInState = {
  partialText: string;
  /** How long the agent has been speaking in this reply. */
  agentSpeakingMs: number;
  /** What the agent was saying when the caller spoke (context for Jev). */
  agentText?: string;
};

export type ReplyState = {
  hasFinal: boolean;
  silenceMs: number;
  toolActive: boolean;
};

export type ToolCallState = {
  name: string;
  transcriptTail: string;
};

export type NavSpeculativeState = {
  partialText: string;
  candidateRoute: string;
  confidence: number;
};

/** One visitor turn on the demo call, scored against the current beat's goal. */
export type OffTrackState = {
  goal: string;
  agentLine: string;
  userText: string;
};

export type JudgeKind = "barge-in" | "reply" | "tool" | "nav-speculative" | "off-track";
export type JudgeSource = "jev" | "fallback";

/**
 * Filler-only tokens that must never yield while the agent holds the floor
 * (breath mishears, hmm, got-it continuers). "yes"/"yeah" are deliberately
 * ABSENT from filler but are NOT commands either: assent waits for the
 * settled final's soft-confirm path instead of cutting in. Mirrors
 * voice-pipeline/turns.py and telephony-bot/voice_judge.py.
 */
export const FILLER_TOKENS = new Set([
  "uh", "huh", "uhhuh", "um", "umm", "uhm", "er", "erm",
  "hmm", "hm", "ah", "oh", "mhm", "mmhm", "mmhmm", "mm",
  "yup", "okay", "ok", "right", "alright", "sure",
  "gotcha", "got", "it", "thanks",
]);

/**
 * Steering that always yields once established, bypassing the word-count
 * floor and the probability threshold: stop/wait/no/repeat. The LLM (which
 * sees the overlap in context) decides transition-vs-continue; the gate
 * only guarantees steering is heard. Mirrors turns.COMMAND_*.
 */
const COMMAND_PHRASES = ["hold on", "hang on", "excuse me"];
const COMMAND_TOKENS = new Set([
  "stop", "wait", "no", "nope", "repeat", "again", "sorry", "listen",
]);

function isAllFiller(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0 && words.every((token) => FILLER_TOKENS.has(token));
}

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length === 1 && words[0] === "" ? 0 : words.length;
}

export function cleanTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when the overlap carries steering (stop/wait/no/repeat...). */
export function isCommandBargeIn(text: string): boolean {
  const tokens = cleanTokens(text);
  if (tokens.length === 0) return false;
  const padded = ` ${tokens.join(" ")} `;
  if (COMMAND_PHRASES.some((phrase) => padded.includes(` ${phrase} `))) {
    return true;
  }
  return tokens.some((token) => COMMAND_TOKENS.has(token));
}

/**
 * Offline probability that `partialText` is a real interruption.
 * Filler-only speech scores near 0; multi-word content while the agent is
 * established scores high. Speech in the first 800ms of a reply is treated
 * as talk-over/echo and scores low (fail-closed). Steering ("no", "stop",
 * "hold on") bypasses the floor and scores 0.9 — it must be heard even as
 * a single word. Bare yes/yeah score like any other single content word:
 * no hard cut — the settled final takes the soft-confirm path instead.
 */
export function heuristicBargeInScore(state: BargeInState): number {
  const text = state.partialText.trim();
  if (!text) return 0;
  if (isAllFiller(text)) return 0.12;
  if (state.agentSpeakingMs < 800) return 0.3;
  if (isCommandBargeIn(text)) return 0.9;
  const words = wordCount(text);
  if (words >= 4) return 0.88;
  if (words >= 2) return 0.72;
  return 0.45;
}

export function shouldYieldToBargeIn(
  state: BargeInState,
  threshold: number = BARGE_IN_THRESHOLD,
): { yield: boolean; probability: number } {
  const probability = heuristicBargeInScore(state);
  return { yield: probability >= threshold, probability };
}

export type ReplyAction = "reply_now" | "wait_300ms" | "play_filler";

export function chooseReplyAction(state: ReplyState): {
  action: ReplyAction;
  probability: number;
} {
  if (state.toolActive) return { action: "play_filler", probability: 0.8 };
  if (state.hasFinal && state.silenceMs >= 600)
    return { action: "reply_now", probability: 0.85 };
  if (!state.hasFinal && state.silenceMs < 300)
    return { action: "wait_300ms", probability: 0.75 };
  if (state.hasFinal) return { action: "reply_now", probability: 0.7 };
  return { action: "play_filler", probability: 0.62 };
}

export function shouldAllowToolCall(state: ToolCallState): {
  allow: boolean;
  probability: number;
} {
  if (!state.name || !/^[a-z][a-z0-9_]*$/i.test(state.name))
    return { allow: false, probability: 0.9 };
  return { allow: true, probability: 0.55 };
}

/**
 * Heuristic gate for speculative voice navigation. High-confidence partials
 * (>=0.8) proceed; mid-confidence (>=0.6) proceeds as prefetch-only; anything
 * without a well-formed route is suppressed. Fail-closed toward suppression
 * on malformed input — the confirmed final turn stays authoritative.
 */
export function shouldAllowSpeculativeNav(state: NavSpeculativeState): {
  allow: boolean;
  probability: number;
} {
  const route = state?.candidateRoute ?? "";
  if (!route || !route.startsWith("/")) return { allow: false, probability: 0.9 };
  const confidence = typeof state.confidence === "number" ? state.confidence : 0;
  if (confidence >= 0.8) return { allow: true, probability: 0.85 };
  if (confidence >= 0.6) return { allow: true, probability: 0.65 };
  return { allow: false, probability: 0.7 };
}

/** Laughter only when repeated: a lone "hi" or "ha" is a greeting, not a joke. */
const LAUGH = /^(?:(?:ha|he|hi|ja|je){2,}h?|lol+|lmf?ao+|rofl|xd+)$/;
const TROLL_TOKENS = new Set(["poop", "fart", "penis", "butt", "fuck", "shit", "boobs"]);

/**
 * Offline probability that a visitor turn is off-track: laughter-only,
 * keyboard mash, a looped word, or trolling words. Silence and short genuine
 * answers score low.
 *
 * ponytail: lexical only, it cannot tell a joke from an answer. Jev owns
 * that; this is the fallback that keeps the ladder alive when Jev is down.
 */
export function heuristicOffTrackScore(text: string): number {
  const tokens = cleanTokens(text);
  if (tokens.length === 0) return 0;
  if (tokens.every((t) => LAUGH.test(t))) return 0.8;
  if (tokens.some((t) => TROLL_TOKENS.has(t))) return 0.75;
  // Keyboard mash: letters-only words with no vowel ("qwrtz"), never hums
  // ("hmmm") or numbers ("2019").
  const mashed = tokens.filter(
    (t) => t.length >= 4 && /^\p{L}+$/u.test(t) && !/^h?m+$/.test(t) && !/[aeiouyàâäéèêëíìîïóòôöúùûü]/.test(t),
  );
  if (mashed.length * 2 >= tokens.length) return 0.8;
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const top = Math.max(...counts.values());
  if (tokens.length >= 3 && top >= 3 && top / tokens.length >= 0.6) return 0.75;
  return 0.1;
}

export function shouldFlagOffTrack(state: OffTrackState): { offTrack: boolean; probability: number } {
  const probability = heuristicOffTrackScore(state?.userText ?? "");
  return { offTrack: probability >= OFF_TRACK_THRESHOLD, probability };
}

export type JudgeDecision =
  | "yield"
  | "keep-speaking"
  | "reply_now"
  | "wait_300ms"
  | "play_filler"
  | "allow"
  | "deny"
  | "off-track"
  | "on-track";

function fallbackDecision(kind: JudgeKind, state: unknown): JudgeDecision {
  if (kind === "barge-in")
    return shouldYieldToBargeIn(state as BargeInState).yield ? "yield" : "keep-speaking";
  if (kind === "reply") return chooseReplyAction(state as ReplyState).action;
  if (kind === "nav-speculative")
    return shouldAllowSpeculativeNav(state as NavSpeculativeState).allow ? "allow" : "deny";
  if (kind === "off-track")
    return shouldFlagOffTrack(state as OffTrackState).offTrack ? "off-track" : "on-track";
  return shouldAllowToolCall(state as ToolCallState).allow ? "allow" : "deny";
}

export async function requestVoiceJudge(
  kind: JudgeKind,
  state: BargeInState | ReplyState | ToolCallState | NavSpeculativeState | OffTrackState,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** The signed-out demo authenticates with its call token here. */
    headers?: Record<string, string>;
  } = {},
): Promise<{ decision: JudgeDecision; probability: number; source: JudgeSource }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl("/api/voice-judge", {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify({ kind, state }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`judge route ${res.status}`);
    const data = (await res.json()) as { decision: JudgeDecision; probability: number };
    if (!data || typeof data.decision !== "string") throw new Error("bad judge payload");
    return {
      decision: data.decision,
      probability: typeof data.probability === "number" ? data.probability : 0.5,
      source: "jev",
    };
  } catch {
    return { decision: fallbackDecision(kind, state), probability: 0.5, source: "fallback" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
