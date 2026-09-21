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

import {
  chooseReplyAction,
  shouldAllowToolCall,
  shouldYieldToBargeIn,
  type BargeInState,
  type JudgeDecision,
  type JudgeKind,
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
  if (kind !== "barge-in" && kind !== "reply" && kind !== "tool") return { ok: false };
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
        "Is this user speech a real interruption that requires the agent to stop speaking immediately? Backchannels (uh-huh, yeah, mhm), echo, and noise are NOT interruptions.",
    };
  if (kind === "reply")
    return {
      type: "choice",
      instructions:
        "Given transcript finality, silence duration, and whether a business tool call is in flight, what should the voice agent do next?",
      options: ["reply_now", "wait_300ms", "play_filler"],
    };
  return {
    type: "boolean",
    instructions:
      "Does this proposed business tool call match the user's apparent intent from the transcript tail? Empty or malformed tool names never match.",
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
  deps: {
    fetchImpl?: typeof fetch;
    gatewayUrl?: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
  } = {},
): Promise<VoiceJudgeResult> {
  const gatewayUrl = deps.gatewayUrl ?? resolveJudgeGatewayUrl();
  const apiKey = deps.apiKey ?? resolveJudgeApiKey();
  if (!apiKey) throw new Error("voice judge gateway not configured");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 1500);
  try {
    const question = judgeQuestions(kind);
    const res = await fetchImpl(gatewayUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: deps.model ?? resolveJudgeModel(),
        state: JSON.stringify({ kind, ...state }).slice(0, 4000),
        questions: { judge: question },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const data = (await res.json()) as {
      answers?: { judge?: { probability?: number; pick?: string } };
    };
    const answer = data?.answers?.judge;
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
    return { decision: probability >= 0.5 ? "allow" : "deny", probability, source: "jev" };
  } finally {
    clearTimeout(timer);
  }
}
