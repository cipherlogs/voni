/**
 * The platform capture is one of the three comparable signals a diagnosis is
 * built from, so the file it writes must report the recording's real rate,
 * channel count and duration. A capture that was silently resampled — or one
 * written with no agent channel at all — sends the comparison to the wrong
 * layer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAudioFile } from "../audio/format-facts";
import {
  RecordingCaptureError,
  agentChannelPcm,
  captureFilePath,
  channelPcm,
  encodeMonoWav,
  parseCaptureFlags,
  resolveRecordingFormat,
} from "./recording-capture";

/** Interleaved s16le stereo frames, caller on the left and agent on the right. */
function stereoPcm(
  frameCount: number,
  sampleAt: (frame: number, channel: number) => number,
): Uint8Array {
  const bytes = new Uint8Array(frameCount * 4);
  const view = new DataView(bytes.buffer);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      view.setInt16((frame * 2 + channel) * 2, sampleAt(frame, channel), true);
    }
  }
  return bytes;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "voni-recording-capture-"));
}

test("a stereo recording reports its own rate, never an assumed 24 kHz", () => {
  const format = resolveRecordingFormat({ sample_rate: 48_000, channels: 2 });

  assert.deepEqual(format, { sampleRate: 48_000, channels: 2 });
});

test("a recording without a stereo agent channel is refused by name", () => {
  for (const metadata of [{ sample_rate: 48_000, channels: 1 }, { sample_rate: 48_000 }]) {
    assert.throws(
      () => resolveRecordingFormat(metadata),
      (error: unknown) =>
        error instanceof RecordingCaptureError &&
        error.name === "RecordingCaptureError" &&
        error.code === "missing-agent-channel",
    );
  }
});

test("a recording that does not report its rate is refused, not defaulted", () => {
  for (const metadata of [{ channels: 2 }, { sample_rate: null, channels: 2 }]) {
    assert.throws(
      () => resolveRecordingFormat(metadata),
      (error: unknown) =>
        error instanceof RecordingCaptureError && error.code === "missing-sample-rate",
    );
  }
});

test("the agent channel is the second channel at the recording's own frame count", () => {
  const format = resolveRecordingFormat({ sample_rate: 16_000, channels: 2 });
  const interleaved = stereoPcm(16_000, (frame, channel) =>
    channel === 0 ? 1000 : -2000 - (frame % 10),
  );

  const agent = agentChannelPcm(interleaved, format);

  assert.equal(agent.byteLength, 32_000);
  const view = new DataView(agent.buffer, agent.byteOffset, agent.byteLength);
  assert.equal(view.getInt16(0, true), -2000);
  assert.equal(view.getInt16(2, true), -2001);
  assert.equal(view.getInt16(agent.byteLength - 2, true), -2009);

  // The caller channel is extracted by the same pass, so the two captures
  // come from one decode and cannot disagree about the recording.
  const caller = channelPcm(interleaved, format, 0);
  assert.equal(new DataView(caller.buffer).getInt16(0, true), 1000);
});

test("an empty agent channel is refused, never written as an empty file", () => {
  const format = resolveRecordingFormat({ sample_rate: 48_000, channels: 2 });

  assert.throws(
    () => agentChannelPcm(new Uint8Array(0), format),
    (error: unknown) =>
      error instanceof RecordingCaptureError && error.code === "empty-agent-channel",
  );
  assert.throws(
    () => encodeMonoWav(new Uint8Array(0), 48_000),
    (error: unknown) =>
      error instanceof RecordingCaptureError && error.code === "empty-agent-channel",
  );
});

test("the kept agent file keeps the recording's true rate and duration", () => {
  const dir = tempDir();
  const path = join(dir, "agent.wav");
  try {
    const interleaved = stereoPcm(24_000, (frame, channel) =>
      channel === 0 ? 0 : (frame % 200) - 100,
    );
    const format = resolveRecordingFormat({ sample_rate: 48_000, channels: 2 });

    writeFileSync(path, encodeMonoWav(agentChannelPcm(interleaved, format), format.sampleRate));
    const { facts } = decodeAudioFile(path);

    assert.equal(facts.sampleRate, 48_000);
    assert.equal(facts.channels, 1);
    assert.equal(facts.frameCount, 24_000);
    assert.equal(facts.durationSeconds, 0.5);
    assert.equal(facts.byteRate, 96_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the kept file's path names the session, so a capture pairs with its call", () => {
  const path = captureFilePath("/tmp/voice-evidence", "sess_abc123", 16_000);

  assert.equal(path, "/tmp/voice-evidence/sess_abc123-agent-16000hz.wav");
});

test("keeping a capture does not request remote deletion", () => {
  const kept = parseCaptureFlags(["--session", "sess_abc", "--keep-audio", "/tmp/out"]);
  assert.deepEqual(kept, { keepAudioDir: "/tmp/out", deleteRemote: false });

  assert.equal(parseCaptureFlags(["--session", "sess_abc"]).keepAudioDir, null);
  assert.deepEqual(parseCaptureFlags(["--session", "sess_abc", "--keep-audio"]), {
    keepAudioDir: "voice-captures",
    deleteRemote: false,
  });
  assert.equal(
    parseCaptureFlags(["--session", "sess_abc", "--delete"]).deleteRemote,
    true,
  );
});
