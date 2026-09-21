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

export type JudgeKind = "barge-in" | "reply" | "tool";
export type JudgeSource = "jev" | "fallback";

const BACKCHANNEL_RE =
  /^(uh[\s-]?huh|yeah?|yep|nope?|mhm+|mm+|ok(ay)?|right|sure|got it|thanks?|ah?[\s.,!?]*)[\s.,!?]*$/i;

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length === 1 && words[0] === "" ? 0 : words.length;
}

/**
 * Offline probability that `partialText` is a real interruption.
 * Backchannels score near 0; multi-word content while the agent is
 * established scores high. Speech in the first 800ms of a reply is treated
 * as talk-over/echo and scores low (fail-closed).
 */
export function heuristicBargeInScore(state: BargeInState): number {
  const text = state.partialText.trim();
  if (!text) return 0;
  if (BACKCHANNEL_RE.test(text)) return 0.12;
  if (state.agentSpeakingMs < 800) return 0.3;
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

export type JudgeDecision = "yield" | "keep-speaking" | "reply_now" | "wait_300ms" | "play_filler" | "allow" | "deny";

function fallbackDecision(kind: JudgeKind, state: unknown): JudgeDecision {
  if (kind === "barge-in")
    return shouldYieldToBargeIn(state as BargeInState).yield ? "yield" : "keep-speaking";
  if (kind === "reply") return chooseReplyAction(state as ReplyState).action;
  return shouldAllowToolCall(state as ToolCallState).allow ? "allow" : "deny";
}

export async function requestVoiceJudge(
  kind: JudgeKind,
  state: BargeInState | ReplyState | ToolCallState,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
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
      headers: { "content-type": "application/json" },
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
