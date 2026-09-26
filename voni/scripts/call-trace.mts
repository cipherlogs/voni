/**
 * Call trace: what AssemblyAI heard and did on one call, turn by turn,
 * merged with the browser's own decisions from the dev log.
 *
 *   npm run call:trace -- <sess_id>
 *   npm run call:trace -- --latest
 *
 * Server side (the session timeline artifact): trigger, what was heard and
 * when, the agent's text, time to first audio, interruptions, tool calls,
 * interruption-delay changes, and hang-up latency (goodbye end → session
 * end). Client side: `[voice-call]` lines (barge-in verdicts, off-track
 * rungs, session id) from `.next/dev/logs/next-development.log` inside the
 * call's window. Read-only.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Turn = {
  trigger?: string;
  status?: string;
  requested_instructions?: string | null;
  user_transcript?: string | null;
  user_speech_started_at_ms?: number | null;
  user_speech_ended_at_ms?: number | null;
  agent_text?: string | null;
  agent_reply_started_at_ms?: number | null;
  agent_reply_ended_at_ms?: number | null;
  interrupted_at_ms?: number | null;
  time_to_first_audio_ms?: number | null;
  tool_calls?: { name: string; arguments?: unknown; duration_ms?: number; is_error?: boolean }[];
};
type Timeline = {
  started_at_unix_ms: number;
  turns?: Turn[];
  config_changes?: { received_at_ms: number; update?: { input?: { turn_detection?: unknown } } }[];
  ended?: { public_reason?: string; duration_seconds?: number };
};

const API = "https://agents.assemblyai.com/v1/sessions";
const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY missing: run with --env-file=.dev.vars");
const auth = { Authorization: `Bearer ${apiKey}` };

async function json<T>(url: string, headers: Record<string, string> = auth): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

const arg = process.argv[2];
if (!arg) throw new Error("Pass a session id or --latest.");
const sessionId =
  arg === "--latest"
    ? (await json<{ sessions: { id: string; agent_id: string | null }[] }>(`${API}?limit=1`)).sessions[0]?.id
    : arg;
if (!sessionId || !/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("No such session.");

const session = await json<{ agent_id: string | null; artifacts: { type: string; url: string }[] }>(
  `${API}/${encodeURIComponent(sessionId)}`,
);
const timelineUrl = session.artifacts.find((a) => a.type === "timeline")?.url;
if (!timelineUrl) throw new Error("No timeline yet: the session may still be finishing.");
const timeline = await json<Timeline>(timelineUrl, {});

const t0 = timeline.started_at_unix_ms;
const endedAt = t0 + (timeline.ended?.duration_seconds ?? 0) * 1000;
const at = (ms: number | null | undefined) => (typeof ms === "number" ? `${((ms - t0) / 1000).toFixed(2)}s` : "  –  ");
const clip = (text: string | null | undefined, n = 110) =>
  text ? (text.length > n ? `${text.slice(0, n)}…` : text).replace(/\s+/g, " ") : "";

console.log(`${sessionId}  agent=${session.agent_id ?? "inline"}  ${timeline.ended?.duration_seconds?.toFixed(1) ?? "?"}s  end=${timeline.ended?.public_reason ?? "?"}`);
console.log("");

type Row = { ms: number; line: string };
const rows: Row[] = [];
let hangupFrom: number | null = null;
for (const turn of timeline.turns ?? []) {
  if (turn.user_transcript) {
    rows.push({
      ms: turn.user_speech_started_at_ms ?? turn.agent_reply_started_at_ms ?? t0,
      line: `${at(turn.user_speech_started_at_ms)}  HEARD   "${clip(turn.user_transcript)}"  (${at(turn.user_speech_started_at_ms)}–${at(turn.user_speech_ended_at_ms)})`,
    });
  }
  const start =
    turn.agent_reply_started_at_ms ?? turn.user_speech_ended_at_ms ?? turn.agent_reply_ended_at_ms ?? null;
  if (turn.agent_text || turn.tool_calls?.length) {
    const gap =
      turn.user_speech_ended_at_ms && turn.agent_reply_started_at_ms
        ? ` gap ${turn.agent_reply_started_at_ms - turn.user_speech_ended_at_ms}ms`
        : "";
    const ttfa = typeof turn.time_to_first_audio_ms === "number" ? ` ttfa ${turn.time_to_first_audio_ms}ms` : "";
    const cut = turn.status === "interrupted" ? `  CUT at ${at(turn.interrupted_at_ms)}` : "";
    const via = turn.trigger === "reply_create" ? `  [reply.create: ${clip(turn.requested_instructions, 70)}]` : "";
    rows.push({
      ms: start ?? t0,
      line: `${at(start)}  VONI    "${clip(turn.agent_text)}"  (${turn.trigger}${ttfa}${gap})${cut}${via}`,
    });
  }
  for (const tool of turn.tool_calls ?? []) {
    rows.push({
      ms: start ?? t0,
      line: `${at(start)}  TOOL    ${tool.name} ${JSON.stringify(tool.arguments ?? {})} ${tool.duration_ms ?? "?"}ms${tool.is_error ? " ERROR" : ""}`,
    });
    if (tool.name === "end_call") hangupFrom = turn.agent_reply_ended_at_ms ?? null;
  }
}
for (const change of timeline.config_changes ?? []) {
  const td = change.update?.input?.turn_detection;
  if (td) rows.push({ ms: change.received_at_ms, line: `${at(change.received_at_ms)}  CONFIG  turn_detection ${JSON.stringify(td)}` });
}

// Browser decisions from the dev log (local HH:MM:SS.mmm, same day as the call).
try {
  const log = await readFile(resolve(".next/dev/logs/next-development.log"), "utf8");
  const midnight = new Date(t0);
  midnight.setHours(0, 0, 0, 0);
  for (const raw of log.split("\n")) {
    if (!raw.includes("[voice-call]")) continue;
    const entry = JSON.parse(raw) as { timestamp: string; message: string };
    const [h, m, rest] = entry.timestamp.split(":");
    const ms = midnight.getTime() + ((Number(h) * 60 + Number(m)) * 60 + Number(rest)) * 1000;
    if (ms < t0 - 2000 || ms > endedAt + 2000) continue;
    rows.push({ ms, line: `${at(ms)}  CLIENT  ${entry.message.replace("[voice-call] ", "")}` });
  }
} catch {
  rows.push({ ms: t0, line: "        (no dev log: client decisions unavailable)" });
}

rows.sort((a, b) => a.ms - b.ms);
for (const row of rows) console.log(row.line);
console.log("");
if (hangupFrom) console.log(`hang-up: session ended ${Math.round(endedAt - hangupFrom)}ms after the goodbye reply ended`);
