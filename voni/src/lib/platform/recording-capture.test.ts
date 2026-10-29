/**
 * The platform capture is one of the three comparable signals a diagnosis is
 * built from, so the file it writes must report the recording's real rate,
 * channel count and duration. A capture that was silently resampled — or one
 * written with no agent channel at all — sends the comparison to the wrong
 * layer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAudioFile } from "../audio/format-facts";
import {
  RecordingCaptureError,
  agentChannelPcm,
  callerChannelPcm,
  captureChannels,
  captureFilePath,
  channelPcm,
  describeCaptures,
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

test("the caller channel is the first channel of the same decode", () => {
  const format = resolveRecordingFormat({ sample_rate: 16_000, channels: 2 });
  const interleaved = stereoPcm(8, (_frame, channel) => (channel === 0 ? 7000 : -7000));

  const caller = callerChannelPcm(interleaved, format);

  assert.equal(caller.byteLength, 16);
  const view = new DataView(caller.buffer, caller.byteOffset, caller.byteLength);
  assert.deepEqual(
    Array.from({ length: 8 }, (_value, frame) => view.getInt16(frame * 2, true)),
    [7000, 7000, 7000, 7000, 7000, 7000, 7000, 7000],
  );
});

test("each kept file's path names the session, its channel and the recording's rate", () => {
  assert.equal(
    captureFilePath("/tmp/voice-evidence", "sess_abc123", 16_000, "agent"),
    "/tmp/voice-evidence/sess_abc123-agent-16000hz.wav",
  );
  assert.equal(
    captureFilePath("/tmp/voice-evidence", "sess_abc123", 16_000, "caller"),
    "/tmp/voice-evidence/sess_abc123-caller-16000hz.wav",
  );
});

test("both channels are kept as files at the recording's own rate", () => {
  const dir = tempDir();
  try {
    const format = resolveRecordingFormat({ sample_rate: 48_000, channels: 2 });
    const interleaved = stereoPcm(24_000, (frame, channel) =>
      channel === 0 ? (frame % 100) + 1000 : -2000 - (frame % 100),
    );

    const report = captureChannels(interleaved, format, {
      directory: dir,
      sessionId: "sess_pair01",
    });

    assert.deepEqual(report.kept.map((kept) => kept.channel), ["caller", "agent"]);
    assert.deepEqual(report.absent, []);
    for (const kept of report.kept) {
      writeFileSync(kept.path, kept.wav);
      const { facts } = decodeAudioFile(kept.path);
      assert.equal(facts.sampleRate, 48_000);
      assert.equal(facts.channels, 1);
      assert.equal(facts.frameCount, 24_000);
      assert.equal(facts.durationSeconds, 0.5);
      assert.equal(kept.frameCount, 24_000);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the kept channels are told apart by content, not only by their names", () => {
  const dir = tempDir();
  try {
    const format = resolveRecordingFormat({ sample_rate: 16_000, channels: 2 });
    const interleaved = stereoPcm(400, (frame, channel) =>
      channel === 0 ? 9000 : -100 - (frame % 100),
    );

    const report = captureChannels(interleaved, format, {
      directory: dir,
      sessionId: "sess_content",
    });
    const kept = new Map(
      report.kept.map((channel) => {
        writeFileSync(channel.path, channel.wav);
        return [channel.channel, decodeAudioFile(channel.path)] as const;
      }),
    );

    const caller = kept.get("caller")!;
    const agent = kept.get("agent")!;
    // A swapped or duplicated pair would fail these: the caller is a steady
    // loud positive tone and the agent a quiet negative ramp.
    assert.equal(Math.min(...caller.samples), 9000);
    assert.equal(Math.max(...caller.samples), 9000);
    assert.equal(Math.max(...agent.samples), -100);
    assert.equal(Math.min(...agent.samples), -199);
    assert.notDeepEqual(Array.from(caller.samples), Array.from(agent.samples));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report names both paths and the session, so the pair is found again", () => {
  const dir = tempDir();
  try {
    const format = resolveRecordingFormat({ sample_rate: 16_000, channels: 2 });
    const interleaved = stereoPcm(8, (_frame, channel) => (channel === 0 ? 500 : -500));

    const report = captureChannels(interleaved, format, {
      directory: dir,
      sessionId: "sess_print01",
    });

    assert.deepEqual(describeCaptures(report), [
      `Session sess_print01: caller channel kept at ${join(dir, "sess_print01-caller-16000hz.wav")} (16000 Hz, 0.00 s).`,
      `Session sess_print01: agent channel kept at ${join(dir, "sess_print01-agent-16000hz.wav")} (16000 Hz, 0.00 s).`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent channel is reported by name, never filled from the other one", () => {
  const dir = tempDir();
  try {
    const format = resolveRecordingFormat({ sample_rate: 24_000, channels: 2 });

    const undecoded = captureChannels(null, format, {
      directory: dir,
      sessionId: "sess_absent",
    });
    assert.deepEqual(undecoded.kept, []);
    assert.deepEqual(
      undecoded.absent.map((entry) => entry.channel),
      ["caller", "agent"],
    );
    assert.deepEqual(readdirSync(dir), []);

    const lines = describeCaptures(undecoded);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(line, /^Session sess_absent: /);
      assert.match(line, / channel absent — /);
    }
    assert.ok(!lines.some((line) => line.includes("-caller-24000hz.wav")));

    const truncated = captureChannels(new Uint8Array(6), format, {
      directory: dir,
      sessionId: "sess_absent",
    });
    assert.deepEqual(truncated.kept, []);
    assert.equal(truncated.absent.length, 2);
    assert.match(truncated.absent[0].reason, /6 bytes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
