/**
 * Server-side voice judge shared by the `/api/voice-judge` route.
 *
 * The route owns the gateway key; this module owns validation and the
 * decision. When `VOICE_JUDGE_GATEWAY_URL` + `VOICE_JUDGE_API_KEY` are set,
 * the route tries Jev (`VOICE_JUDGE_MODEL`, default `typesafe-ai/jev`) with a
 * small state blob and typed questions, then falls back here on any failure.
 * Without gateway env, every decision is the heuristic — so dev, tests, and
 * the PSTN path all work offline with fail-closed behavior.
 */

import { secret } from "@/lib/env";
import {
  chooseReplyAction,
  shouldAllowSpeculativeNav,
  OFF_TRACK_THRESHOLD,
  shouldAllowToolCall,
  shouldFlagOffTrack,
  shouldYieldToBargeIn,
  type BargeInState,
  type JudgeDecision,
  type JudgeKind,
  type NavSpeculativeState,
  type OffTrackState,
  type ReplyState,
  type ToolCallState,
} from "./jev-judges";

export type VoiceJudgeSource = "jev" | "heuristic";

export type VoiceJudgeResult = {
  decision: JudgeDecision;
  probability: number;
  source: VoiceJudgeSource;
};

export function parseVoiceJudgeRequest(body: unknown): {
  ok: boolean;
  kind?: JudgeKind;
  state?: Record<string, unknown>;
} {
  if (!body || typeof body !== "object") return { ok: false };
  const { kind, state } = body as { kind: unknown; state: unknown };
  if (
    kind !== "barge-in" &&
    kind !== "reply" &&
    kind !== "tool" &&
    kind !== "nav-speculative" &&
    kind !== "off-track"
  )
    return { ok: false };
  if (!state || typeof state !== "object") return { ok: false };
  return { ok: true, kind, state: state as Record<string, unknown> };
}

/** Offline decision. Fail-closed: unsure barge-in keeps the agent speaking. */
export function decideVoiceJudge(kind: JudgeKind, state: unknown): VoiceJudgeResult {
  if (kind === "barge-in") {
    const { yield: y, probability } = shouldYieldToBargeIn(state as BargeInState);
    return { decision: y ? "yield" : "keep-speaking", probability, source: "heuristic" };
  }
  if (kind === "reply") {
    const { action, probability } = chooseReplyAction(state as ReplyState);
    return { decision: action, probability, source: "heuristic" };
  }
  if (kind === "nav-speculative") {
    const { allow, probability } = shouldAllowSpeculativeNav(state as NavSpeculativeState);
    return { decision: allow ? "allow" : "deny", probability, source: "heuristic" };
  }
  if (kind === "off-track") {
    const { offTrack, probability } = shouldFlagOffTrack(state as OffTrackState);
    return { decision: offTrack ? "off-track" : "on-track", probability, source: "heuristic" };
  }
  const { allow, probability } = shouldAllowToolCall(state as ToolCallState);
  return { decision: allow ? "allow" : "deny", probability, source: "heuristic" };
}

export function judgeQuestions(kind: JudgeKind): {
  type: "boolean" | "choice";
  instructions: string;
  options?: string[];
} {
  if (kind === "barge-in")
    return {
      type: "boolean",
      instructions:
        "The caller spoke (partialText) while the voice agent was saying agentText. Is this a real interruption that requires the agent to stop speaking immediately? A question or a new point that changes the direction counts; an answer or comment that can wait until the agent finishes its sentence does not, and neither does the agent's own words echoed back. Backchannels (uh-huh, yeah, mhm), breathing, humming, singing, and filler-only sounds are NOT interruptions. Steering — stop, wait, no, hold on, repeat — always counts as real even as a single word: the agent finishes its current phrase, acknowledges briefly, then follows. A bare yes counts as real too — the agent confirms it gracefully instead of talking over it.",
    };
  if (kind === "reply")
    return {
      type: "choice",
      instructions:
        "Given transcript finality, silence duration, and whether a business tool call is in flight, what should the voice agent do next?",
      options: ["reply_now", "wait_300ms", "play_filler"],
    };
  if (kind === "nav-speculative")
    return {
      type: "boolean",
      instructions:
        "Does this partial-utterance navigation candidate match what the user is starting to say? Only allow when the candidate route clearly matches the spoken prefix; suppress on ambiguous or unrelated partials.",
    };
  if (kind === "off-track")
    return {
      type: "boolean",
      instructions:
        "On a live sales demo call, is the visitor's latest turn (userText) off-track: jokes, nonsense, trolling, or deliberately stalling instead of engaging with the goal? Genuine short answers, questions about Voni or the demo, hesitation, and small talk that still answers the agent are ON-track. Judge the turn against the goal and the agent's last line.",
    };
  return {
    type: "boolean",
    instructions:
      "Does this proposed business tool call match the user's apparent intent from the transcript tail? Empty or malformed tool names never match.",
  };
}

/** How a Jev call reaches the gateway; every field falls back to process env. */
export type JevDeps = {
  fetchImpl?: typeof fetch;
  gatewayUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
};

/**
 * Gateway settings from secrets: process.env first (tests, CI, plain Node),
 * the Cloudflare context as fallback, so it works under `next dev` and on the
 * deployed Worker. The user's `AI_GATEWAY_API_KEY` wins over `VOICE_JUDGE_API_KEY`.
 */
export async function judgeDepsFromSecrets(): Promise<JevDeps> {
  return {
    apiKey: (await secret("AI_GATEWAY_API_KEY")) ?? (await secret("VOICE_JUDGE_API_KEY")),
    gatewayUrl: (await secret("VOICE_JUDGE_GATEWAY_URL")) ?? resolveJudgeGatewayUrl(),
    model: (await secret("VOICE_JUDGE_MODEL")) ?? resolveJudgeModel(),
  };
}

/** Vercel AI Gateway evaluate endpoint. Override with VOICE_JUDGE_GATEWAY_URL. */
export const JUDGE_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/evaluate";
/** Jev model id on the gateway. Override with VOICE_JUDGE_MODEL. */
export const JUDGE_MODEL = "typesafe-ai/jev";

/**
 * The user's existing `AI_GATEWAY_API_KEY` wins; `VOICE_JUDGE_API_KEY` is the
 * judge-specific fallback. Callers running on the Worker should resolve via
 * `secret()` and pass the result as `deps.apiKey` instead.
 */
export function resolveJudgeApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.AI_GATEWAY_API_KEY ?? env.VOICE_JUDGE_API_KEY;
}

export function resolveJudgeGatewayUrl(env: Record<string, string | undefined> = process.env): string {
  return env.VOICE_JUDGE_GATEWAY_URL ?? JUDGE_GATEWAY_URL;
}

export function resolveJudgeModel(env: Record<string, string | undefined> = process.env): string {
  return env.VOICE_JUDGE_MODEL ?? JUDGE_MODEL;
}

/**
 * Attempt a Jev judgment through the Vercel AI Gateway evaluate endpoint.
 * Throws on any failure so the caller falls back to `decideVoiceJudge`.
 */
export async function tryJevGateway(
  kind: JudgeKind,
  state: Record<string, unknown>,
  deps: JevDeps = {},
): Promise<VoiceJudgeResult> {
  const answer = await jevEvaluate({ kind, ...state }, judgeQuestions(kind), deps);
  const probability =
    typeof answer?.probability === "number" ? answer.probability : 0.5;
  if (kind === "reply") {
    const pick = answer?.pick;
    const decision =
      pick === "reply_now" || pick === "wait_300ms" || pick === "play_filler"
        ? pick
        : decideVoiceJudge(kind, state).decision;
    return { decision, probability, source: "jev" };
  }
  if (kind === "barge-in")
    return {
      decision: probability >= 0.65 ? "yield" : "keep-speaking",
      probability,
      source: "jev",
    };
  if (kind === "nav-speculative")
    return {
      decision: probability >= 0.6 ? "allow" : "deny",
      probability,
      source: "jev",
    };
  if (kind === "off-track")
    return {
      decision: probability >= OFF_TRACK_THRESHOLD ? "off-track" : "on-track",
      probability,
      source: "jev",
    };
  return { decision: probability >= 0.5 ? "allow" : "deny", probability, source: "jev" };
}

export type JevQuestion = ReturnType<typeof judgeQuestions>;

/**
 * One Jev evaluation through the Vercel AI Gateway: a state blob and one
 * typed question. Throws on any failure (no key, timeout, HTTP error), so
 * every caller keeps its own fallback.
 */
export async function jevEvaluate(
  state: Record<string, unknown>,
  question: JevQuestion,
  deps: JevDeps = {},
): Promise<{ probability?: number; pick?: string } | undefined> {
  const gatewayUrl = deps.gatewayUrl ?? resolveJudgeGatewayUrl();
  const apiKey = deps.apiKey ?? resolveJudgeApiKey();
  if (!apiKey) throw new Error("voice judge gateway not configured");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 1500);
  try {
    const res = await fetchImpl(gatewayUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: deps.model ?? resolveJudgeModel(),
        state: JSON.stringify(state).slice(0, 4000),
        questions: { judge: question },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const data = (await res.json()) as {
      answers?: { judge?: { probability?: number; pick?: string } };
    };
    return data?.answers?.judge;
  } finally {
    clearTimeout(timer);
  }
}
