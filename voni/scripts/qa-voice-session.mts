/**
 * Server-only AssemblyAI Voice Agent session QA.
 *
 * Fetches fresh artifact URLs, downloads the timeline, metadata, and stereo
 * OGG into a temporary directory, computes sanitized measurements, writes an
 * evidence JSON file, then optionally soft-deletes the remote test session.
 * Raw audio and pre-signed URLs never leave the temporary directory or logs.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveCredential } from "../src/lib/platform/credentials";

type Artifact = {
  type: "audio" | "timeline" | "metadata";
  url: string;
  content_type: string;
};

type Session = {
  id: string;
  agent_id: string | null;
  status: string;
  public_close_reason: string | null;
  duration_seconds: number | null;
  created_at: string | null;
  ended_at: string | null;
  artifacts: Artifact[];
};

type TimelineTurn = {
  status?: string;
  trigger?: string;
  user_transcript?: string | null;
  agent_text?: string | null;
  time_to_first_audio_ms?: number;
  agent_reply_started_at_ms?: number;
  agent_reply_ended_at_ms?: number;
  tool_calls?: Array<{ duration_ms?: number; is_error?: boolean; timed_out?: boolean }>;
};

type Timeline = { session_id?: string; turns?: TimelineTurn[] };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeTranscript(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .slice(0, 1000)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d ()-]{7,}\d/g, "[phone]")
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, "[credential]");
}

function analyzePcm(buffer: Buffer) {
  const samples = new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / 2),
  );
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  let longestSilence = 0;
  let silenceRun = 0;
  let largestStep = 0;
  let previous = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    sumSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude >= 32760) clipped += 1;
    if (magnitude <= 8) {
      silenceRun += 1;
      longestSilence = Math.max(longestSilence, silenceRun);
    } else {
      silenceRun = 0;
    }
    largestStep = Math.max(largestStep, Math.abs(sample - previous));
    previous = sample;
  }
  const count = samples.length;
  return {
    samples: count,
    rmsDbfs:
      count === 0 || sumSquares === 0
        ? null
        : Number((20 * Math.log10(Math.sqrt(sumSquares / count) / 32768)).toFixed(2)),
    peakDbfs:
      peak === 0 ? null : Number((20 * Math.log10(peak / 32768)).toFixed(2)),
    clippedSampleRatio: count === 0 ? null : Number((clipped / count).toFixed(8)),
    longestDigitalSilenceMs: Number(((longestSilence / 24000) * 1000).toFixed(2)),
    largestAdjacentStep: largestStep,
    nonSilent: peak > 8,
  };
}

function decodeChannel(audioPath: string, channel: "left" | "right"): Buffer | null {
  const channelIndex = channel === "left" ? "FL" : "FR";
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      audioPath,
      "-af",
      `pan=mono|c0=${channelIndex}`,
      "-ar",
      "24000",
      "-acodec",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ],
    { encoding: null, maxBuffer: 128 * 1024 * 1024 },
  );
  return result.status === 0 && Buffer.isBuffer(result.stdout)
    ? result.stdout
    : null;
}

async function fetchChecked(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`AssemblyAI session request failed with HTTP ${response.status}.`);
  }
  return response;
}

async function main() {
  const sessionId = arg("--session") ?? process.env.ASSEMBLYAI_SESSION_ID;
  const evidenceArg = arg("--evidence-out");
  const profile = arg("--profile") ?? null;
  const shouldDelete = process.argv.includes("--delete");
  if (!sessionId || !/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error("Pass a valid session with --session or ASSEMBLYAI_SESSION_ID.");
  }
  if (shouldDelete && !evidenceArg) {
    throw new Error("--delete requires --evidence-out so measurements are saved first.");
  }

  const apiKey = (await resolveCredential("assemblyai_api_key")).value;
  if (!apiKey) throw new Error("AssemblyAI is not configured for this server.");
  const authorization = { Authorization: `Bearer ${apiKey}` };
  const base = "https://agents.assemblyai.com/v1/sessions";
  const session = (await (
    await fetchChecked(`${base}/${encodeURIComponent(sessionId)}`, {
      headers: authorization,
    })
  ).json()) as Session;
  if (session.status !== "completed") {
    throw new Error(`Session ${session.id} is ${session.status}; artifacts are not ready.`);
  }

  const artifacts = new Map(session.artifacts.map((item) => [item.type, item]));
  for (const required of ["audio", "timeline", "metadata"] as const) {
    if (!artifacts.has(required)) throw new Error(`Session is missing its ${required} artifact.`);
  }

  const qaDir = await mkdtemp(resolve(tmpdir(), "voni-voice-qa-"));
  try {
    const [audioResponse, timelineResponse, metadataResponse] = await Promise.all([
      fetchChecked(artifacts.get("audio")!.url),
      fetchChecked(artifacts.get("timeline")!.url),
      fetchChecked(artifacts.get("metadata")!.url),
    ]);
    const audio = Buffer.from(await audioResponse.arrayBuffer());
    const timeline = (await timelineResponse.json()) as Timeline;
    const metadata = (await metadataResponse.json()) as Record<string, unknown>;
    const audioPath = resolve(qaDir, "recording.ogg");
    await writeFile(audioPath, audio);

    const turns = timeline.turns ?? [];
    const firstAudio = turns
      .map((turn) => turn.time_to_first_audio_ms)
      .filter((value): value is number => typeof value === "number");
    const transcripts = turns.map((turn) => ({
      user: turn.user_transcript ?? null,
      agent: turn.agent_text ?? null,
      status: turn.status ?? null,
    }));
    const left = decodeChannel(audioPath, "left");
    const right = decodeChannel(audioPath, "right");
    const evidence = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      session: {
        id: session.id,
        agentId: session.agent_id,
        status: session.status,
        closeReason: session.public_close_reason,
        durationSeconds: session.duration_seconds,
        createdAt: session.created_at,
        endedAt: session.ended_at,
      },
      timeline: {
        commandProfile: profile,
        turnCount: turns.length,
        completedTurns: turns.filter((turn) => turn.status === "completed").length,
        interruptedTurns: turns.filter((turn) => turn.status === "interrupted").length,
        firstAudioMs: firstAudio,
        firstAudioP95Ms: percentile(firstAudio, 95),
        toolCallCount: turns.reduce((sum, turn) => sum + (turn.tool_calls?.length ?? 0), 0),
        toolErrorCount: turns.reduce(
          (sum, turn) =>
            sum +
            (turn.tool_calls ?? []).filter((call) => call.is_error || call.timed_out)
              .length,
          0,
        ),
        transcriptSha256: sha256(JSON.stringify(transcripts)),
        transcripts: transcripts.map((turn) => ({
          user: sanitizeTranscript(turn.user),
          agent: sanitizeTranscript(turn.agent),
          status: turn.status,
        })),
        userWordCount: turns.reduce(
          (sum, turn) => sum + (turn.user_transcript?.trim().split(/\s+/).filter(Boolean).length ?? 0),
          0,
        ),
        agentWordCount: turns.reduce(
          (sum, turn) => sum + (turn.agent_text?.trim().split(/\s+/).filter(Boolean).length ?? 0),
          0,
        ),
      },
      recording: {
        sha256: sha256(audio),
        bytes: audio.byteLength,
        contentType: artifacts.get("audio")!.content_type,
        format: metadata.format ?? null,
        channels: metadata.channels ?? null,
        channelLayout: metadata.channel_layout ?? null,
        sampleRate: metadata.sample_rate ?? null,
        userChannel: left ? analyzePcm(left) : null,
        agentChannel: right ? analyzePcm(right) : null,
        decoder: right ? "ffmpeg" : "unavailable",
      },
    };

    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (evidenceArg) {
      const evidencePath = resolve(evidenceArg);
      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, serialized, { mode: 0o600 });
      console.log(`Voice QA evidence written to ${evidencePath}.`);
    } else {
      process.stdout.write(serialized);
    }

    if (shouldDelete) {
      const deleted = await fetch(`${base}/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: authorization,
      });
      if (deleted.status !== 204) {
        throw new Error(`Evidence was saved, but session deletion returned HTTP ${deleted.status}.`);
      }
      console.log(`Deleted remote test session ${sessionId}.`);
    }
  } finally {
    await rm(qaDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Voice QA failed.");
  process.exitCode = 1;
});
