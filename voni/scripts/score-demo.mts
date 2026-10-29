/**
 * Demo scoreboard orchestrator: one command that scores a full Demo call
 * with real audio and writes one JSON artifact plus a console pass/fail
 * table.
 *
 * Single seam at the npm-script level. This file drives the existing runners
 * — it forks none of their logic and invents no transport:
 *   - real-audio eval runner:  npm run eval:demo-agent -- --voice <v> --scenario <s> --runs <n>
 *   - Call trace merger:        npm run call:trace -- <sess_id>        (via --trace-session)
 *   - session evidence exporter: npm run qa:voice-session -- --session <id> --evidence-out <path>
 *   - browser e2e fakes live in tests/e2e/demo-fakes.ts (unchanged here).
 *
 * Gates: the reply-gap, end-of-turn, filler-resume, barge-in-cut,
 * overheard-recall, dead-air, double-talk and end-call-drain gates fail the command (exit 1) when measured
 * evidence breaches the budget, so regressions never merge silently. A real
 * (non-dry) run with zero measured evidence fails too ("no measurements -
 * run real audio or pass evidence flags"): --dry-run stays exit 0 INFO
 * (explicit dry), but a real run may never green on zero measurements.
 * Plumbing and judgment are separate: an eval runner that finished (its
 * summary printed, whatever the exit code) is plumbing PASS even when a
 * scenario or a measured gate FAILs. A spawn failure, a kill, a crash, no
 * summary, a run with no Call trace session, or a run with no agent audio is
 * a harness break (exit 1, plumbing FAIL, evalRunner status failed) — distinct
 * from a measured gate FAIL (exit 1). Live scenario playout is printed as
 * wall clock under `evalRunner.timings` and never folded into a gate.
 * Non-zero exit otherwise means the harness broke: unknown voice, bad
 * --runs/--gap/--filler/--cut/--overheard-json/--email-json/--dead-air-gaps/--overlap-ms/--goodbye-coverage/--hang-up-delay-ms/--trace-beat flag, spawn failure,
 * or an unwritable artifact.
 *
 *   npm run scoreboard:demo -- [--gate-voice <demo-voice-id>] [--scenario greeting-cut] [--runs 1]
 *                           [--out scoreboard-runs/score-<ts>-<voice>.json] [--dry-run]
 *                           [--prior <path>]
 *                           [--timing-lock /tmp/voni-demo-timing.lock]
 *                           [--trace-session sess_...] [--trace-beat greeting-cut] [--probe-json probes.json] [--recording <sha256> | --recording-file <path>] [--rate rater:timbre,accent ...]
 *                           [--gap beat=ms ...]
 *                           [--filler-text "Okaay so" --filler-cut-ms 320 ...]
 *                           [--cut-ms <n> | --cut-never] [--cut-verdict <v>] [--cut-answered]
 *                           [--cut-resumed] [--cut-ended] [--trace-turn <text>]
 *                           [--overheard-json asides.json] [--email-json email.json]
 *                           [--dead-air-gaps 400,1200] [--longest-silence-ms 16000]
 *                           [--check-in-at-ms 15200] [--check-in-over-caller]
 *                           [--silence-json silence.json]
 *                           [--overlap-ms 120,350] [--goodbye-coverage 0.95]
 *                           [--goodbye-inbox-named | --goodbye-inbox-missing]
 *                           [--hang-up-delay-ms 900] [--narrated-ending]
 *
 * --gate-voice picks the gate voice through the shared voice registry
 * (--voice stays an alias); omitting both gates on DEFAULT_GATE_VOICE, never
 * on a literal in this file. New voices deploy as a registry entry plus a
 * regression run: the dry run lists the gate plus the regression set.
 *
 * A live (non-dry) run takes an exclusive timing lock (default in the OS temp
 * dir, override with --timing-lock) so timing runs go one at a time; a second
 * run fails fast naming the holder instead of inflating cut latency under
 * parallel load. The lock is released on exit and a dead holder is reclaimed.
 *
 * Every artifact records a codeFingerprint (git HEAD plus a hash of the
 * uncommitted status and diff). `npm run scoreboard:streak` reads the last
 * three gate-voice artifacts and refuses the exit claim when the fingerprint
 * moved, a required gate is not PASS, or the candidate behavior run is
 * missing/red. Artifacts with no fingerprint (git unavailable) cannot form a
 * streak.
 *
 * --prior <path> pins the artifact a run diffs against; omit it and the
 * latest same-voice artifact in this run's output directory is used. The diff
 * prints right after the gate table (gate status transitions, per-beat metric
 * deltas, reply-gap and goodbye-drain changes); the first run in a directory
 * prints "no prior artifact" and still exits normally. Artifacts stay
 * gitignored working files and are never committed.
 *
 * --gap feeds a measured reply gap (visitor end-of-speech → first agent
 * audio) to a beat; repeat for several runs. --trace-session merges the
 * Call trace for a finished real-call session: its per-turn `gap Nms`
 * numbers feed the gate and the console lists one `turn N  Nms` row per
 * VONI reply plus the session id to replay. The live eval runner prints
 * `· trace session sess_…`; when --trace-session is omitted the last one is
 * chained automatically (a timeline that is not ready yet defers the merge
 * and prints the replay command instead of breaking the harness). The first
 * merged turn attributes to the greeting-cut beat only when the excerpt
 * opens with the greeting cut; otherwise --trace-beat may name it.
 *
 * The live runner's own `filler …` line feeds the filler-over observed
 * behavior, so a filler run scores the filler-resume gate without flags. A
 * cut line also carries the agent line, the heard words and the resumed tail,
 * so the exact unheard rest is compared verbatim and the Call trace points at
 * the resume turn (or the cut turn when nothing played). --filler-text and
 * its siblings override that observation; without either the gate stays INFO.
 * --trace-session fills --filler-trace-turn when the flag is absent, so a
 * failure still points at the Call trace turn or says explicitly that no turn
 * was merged.
 *
 * Dead-air evidence is derived from the call's own session timeline, never
 * guessed. The live runner prints one `SILENCE TIMELINE {...}` line per live
 * client call: the audible agent/caller windows, agent reply starts and
 * reply.create requests (coverage), and any check-ins. score-demo derives the
 * free-floor silences from it automatically: an uncovered stretch longer than
 * the 2s window fails, a stretch covered by an agent reply start or a timely
 * check-in does not. A FAIL cites the surrounding Call trace turns plus the
 * silence window and deadAir.gapsMs — a silent gap has no trace row of its own,
 * so no row is invented. --silence-json replays a documented timeline of the
 * same shape. --dead-air-gaps/--longest-silence-ms/--check-in-at-ms
 * (comma-separated atSilenceMs, one per check-in) stay explicit overrides;
 * --check-in-over-caller marks the listed check-ins as overlapping caller
 * speech. With no timeline and no flags the dead-air gate stays INFO
 * (unmeasured, never PASS). --silence-json shape (the runner line's payload
 * minus scenario/session): {"startedMs":0,"endedMs":6000,
 * "agentAudio":[{"startMs":0,"endMs":1000}],
 * "callerSpeech":[{"startMs":1000,"endMs":1500}],
 * "coverage":[{"atMs":4000}],"checkIns":[{"atMs":16200,"overCaller":false}]}.
 *
 * Invite evidence (ticket 26): the live runner prints one `EMAIL INVITE
 * {...}` line per invite-tag run (show-tool count, every spoken agent line,
 * the chip show with inbox+tag, and each line's session turn). score-demo
 * scores it with applyEmailInvite; --email-json overrides it with a browser
 * probe or replay of the same shape (plus optional Hold-memory before/after
 * fields). A hand-supplied file must carry traceSession so a FAIL cites the
 * Call trace turn where the invite repeated, split the tag, or the chip
 * duplicated. Memory left unmeasured stays INFO, never PASS.
 *
 * Measured evidence for the ticket-09 gates (no live audio in CI, so a real
 * run or a replay feeds them in): the live runner's `DOUBLE TALK {...}` line
 * (over-talk) carries the post-flush residual overlap per cut — the ms both
 * the caller's speech and the faded agent playout were still sounding after
 * the flush, never time-to-cut — and feeds the gate automatically; a FAIL
 * cites the Call trace turn of the interrupted reply (or states that no turn
 * was merged when the overlap came from a different call). --overlap-ms
 * overrides it with audible overlap per cut (FAIL past 400ms). The runner's
 * `GOODBYE DRAIN {...}` line (bye-audio/free-gate) feeds the drain gate
 * automatically: played/expected goodbye coverage, whether the closing line
 * named hi@voni.cc as spoken, and the runner's own closing turn; its
 * `hung up Nms` line feeds the end-of-audio-to-session-close delay. A FAIL
 * cites that turn (or states no turn was merged when the evidence came from
 * a different call). --goodbye-coverage, --goodbye-inbox-named/-missing and
 * --hang-up-delay-ms override the runner's numbers; the line's own
 * narratedEnding field (or a post-End turn in the merged trace) fails the
 * drain gate, and --narrated-ending flags it for a human replay. A narration
 * FAIL cites the post-End turn, else says no turn was merged. Omitted
 * evidence is INFO, never a false PASS.
 *
 * --probe-json carries the session onAudioProbe counts plus the optional
 * qa-voice-session agent-channel PCM analysis; it drives the timbre-probes
 * gate (any clip, pop, jump, underrun, or input-drop FAILs the gate but the
 * artifact is still written). --rate files blind 1-5 human ballots, all
 * bound to one shared golden recording via --recording or --recording-file;
 * auto timbre checks must pass before ballots count, and a ballot without a
 * recording is rejected (see voni/docs/blind-human-ballots.md).
 *
 * Extensions kept beyond the ticket scope (documented, not silent):
 * agent-channel PCM evidence rides in --probe-json (offline
 * qa-voice-session analysis); --trace-beat explicitly maps the first merged
 * trace turn only when the session does not open with the greeting cut.
 *
 * --dry-run skips spawning the runner (no ASSEMBLYAI_API_KEY needed) and
 * records a placeholder eval section. --trace-session merges the Call trace
 * for a finished real-call session into the artifact excerpt, and its HEARD
 * rows become ledger-counted overheard asides (handling from the CLIENT
 * barge-in verdicts). The first merged turn attributes to the greeting-cut
 * beat only when verified: the excerpt opens with a greeting-cut marker
 * (golden runs open with the greeting cut) or --trace-beat names the beat
 * explicitly. An excerpt that opens with the greeting cut always wins over
 * an explicit --trace-beat map. Otherwise the first turn is scored
 * call-level and the greeting-cut beat reports INFO with a "trace
 * attribution unverified" warning, never PASS. --overheard-json feeds
 * explicit asides (marked, ledger, handling, trace pointer per beat); it
 * merges with trace-derived ones.
 *
 * Real-cut gate (ticket 05): when the eval output carries a real-cut
 * scenario (stop-over, hang-up-over, hang-up-fast), the barge-in-cut gate is
 * evaluated from the runner's cut milliseconds, verdict, and resume lines,
 * and the real-cut-answered beat carries the measured cut. The same evidence
 * can be passed explicitly (dry-run friendly): --cut-ms with --cut-answered
 * passes a fast answered cut, --cut-never / a late --cut-ms / --cut-resumed /
 * a missing --cut-answered fails with cut ms plus verdict and trace turn.
 * Explicit flags override the parsed runner output per field. With neither
 * parsed nor explicit evidence the gate stays INFO: recorded, not failed.
 * The runner's fixed caller clip fingerprints are recorded in the artifact;
 * if the same line's clip changed since the prior run, the gate FAILs as not
 * comparable instead of reporting a shorter take as a faster cut.
 *
 * Greeting-cut gate (ticket 08): the greeting-cut scenario's measured ms
 * fills beats["greeting-cut"].cutMs and drives a required greeting-cut gate.
 * A passed run with no measured line stays INFO (never a false PASS); a
 * failed run with no cut line FAILs and cites the interrupted greeting turn
 * from the merged Call trace (or says no turn was merged).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  addHumanRating,
  applyEmailInvite,
  applyGreetingCutGate,
  applyRealCutGate,
  buildSkeletonArtifact,
  callerClipChanges,
  callerClipsFromRunnerStdout,
  DEFAULT_GATE_VOICE,
  deriveFreeFloorSilence,
  diffScoreboardArtifact,
  emptyHumanRatings,
  extractGreetingCutEvidence,
  extractRealCutEvidence,
  extractTraceSessionId,
  fillerEvidenceFromRun,
  formatArtifactDiff,
  formatBudgetReport,
  formatEvalRunnerReport,
  formatGateTable,
  formatGoldenScript,
  formatHumanReview,
  formatOverheardReport,
  formatReplyGapReport,
  formatSubScoreTable,
  formatTraceTurn,
  formatVoiceGainTable,
  GOLDEN_BEATS,
  HANG_UP_AFTER_GOODBYE_MAX_MS,
  overheardFromTraceExcerpt,
  parseEmailInviteOutput,
  parseFillerRunOutput,
  parseGoodbyeDrainOutput,
  parseHeardLedgerOutput,
  parseDoubleTalkOutput,
  parseSilenceTimeline,
  parseSilenceTimelineOutput,
  parseRunnerHangUp,
  parseTraceGaps,
  readCodeFingerprint,
  redactLines,
  resolveGateVoice,
  sha256Hex,
  traceSilenceRef,
  traceCheckInRef,
  traceTurnForVisitorSpeech,
  traceTurnPointers,
  traceTurnsForAgentLines,
  validateEmailInviteEvidence,
  validateProbeCounts,
  type AgentChannelEvidence,
  type DeadAirEvidence,
  type DeadAirSilence,
  type EmailInviteEvidence,
  type EmailInviteEvidenceFile,
  type FillerResumeEvidence,
  type FillerVerdict,
  type GoldenBeat,
  type HumanRatings,
  type OverheardAside,
  type RealCutEvidence,
  type RunnerHangUpEvidence,
  type ScoreboardArtifact,
  type SilenceTimeline,
  type TimbreProbes,
  type TraceGap,
} from "../src/lib/demo/scoreboard";
import { buildDemoAgentBody } from "../src/lib/demo/stored-agents";
import { judgeOverlap } from "../src/lib/voice/barge-in";
import { acquireTimingLock, DEFAULT_TIMING_LOCK_PATH } from "../src/lib/demo/timing-lock";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/** Every value passed to a repeatable flag, in order. */
function argAll(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && i + 1 < process.argv.length) values.push(process.argv[i + 1]);
  }
  return values;
}

/**
 * Session probe counts collected during the golden run
 * (VoiceSession onAudioProbe plus the qa-voice-session agent-channel PCM
 * analysis). Missing counts default to zero; anything negative or
 * non-integer is a harness bug, not a clean run.
 */
function readProbeJson(path: string): { probes: TimbreProbes; agentChannel: AgentChannelEvidence | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`--probe-json ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`--probe-json ${path} must be an object of probe counts`);
  }
  const record = parsed as Record<string, unknown>;
  // Probe-count shape lives in scoreboard.ts (validateProbeCounts): one
  // validator for the orchestrator and the matrix.
  const probes = validateProbeCounts(record, `--probe-json ${path}`);
  const rawChannel = record.agentChannel ?? null;
  if (rawChannel === null || rawChannel === undefined) return { probes, agentChannel: null };
  if (typeof rawChannel !== "object") {
    throw new Error(`--probe-json ${path}: agentChannel must be an object or absent`);
  }
  const channel = rawChannel as Record<string, unknown>;
  const agentChannel: AgentChannelEvidence = { peakDbfs: null, clippedSampleRatio: null, largestAdjacentStep: null };
  for (const field of ["peakDbfs", "clippedSampleRatio", "largestAdjacentStep"] as const) {
    const value = channel[field] ?? null;
    if (value !== null && typeof value !== "number") {
      throw new Error(`--probe-json ${path}: agentChannel.${field} must be a number or null`);
    }
    agentChannel[field] = value;
  }
  return { probes, agentChannel };
}

/**
 * Load explicit invite evidence for `--email-json` (a browser/e2e probe, a
 * replay, or the runner's own EMAIL INVITE object). A hand-supplied file
 * must name its Call trace session so a FAIL can cite the turn; malformed
 * evidence is a harness error and writes no artifact.
 */
function readEmailInviteJson(path: string): EmailInviteEvidenceFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`--email-json ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateEmailInviteEvidence(parsed, `--email-json ${path}`, { requireSession: true });
}

/**
 * Trace pointer for the runner's GOODBYE DRAIN evidence: its own closing turn
 * only when the evidence came from the merged call. Another call's session
 * means no turn was merged, stated explicitly rather than guessed.
 */
function goodbyeEvidenceTraceRef(
  evidence: { sessionId: string | null; turn: number | null },
  traceSession: string,
): string {
  if (evidence.sessionId && traceSession && evidence.sessionId !== traceSession) {
    return `${evidence.sessionId} (no turn merged: trace session ${traceSession} is a different call)`;
  }
  if (evidence.turn !== null && evidence.sessionId && evidence.sessionId === traceSession) {
    return formatTraceTurn(evidence.turn, traceSession);
  }
  return `no turn merged${evidence.sessionId ? ` (${evidence.sessionId})` : ""}`;
}

/**
 * Trace pointer for a slow hang-up: the closing turn of the call whose drain
 * ran long, read from that call's merged excerpt. Another call's session means
 * no turn was merged, stated explicitly rather than citing a turn that did
 * not run long.
 */
function hangUpEvidenceTraceRef(
  evidence: RunnerHangUpEvidence,
  traceSession: string,
  excerpt: string[] | null,
): string {
  if (evidence.sessionId && traceSession && evidence.sessionId !== traceSession) {
    return `${evidence.sessionId} (no turn merged: trace session ${traceSession} is a different call)`;
  }
  const turn = excerpt ? traceTurnPointers(excerpt).goodbyeTurn : null;
  if (turn !== null) return formatTraceTurn(turn, traceSession || evidence.sessionId || null);
  return `no turn merged${evidence.sessionId ? ` (${evidence.sessionId})` : ""}`;
}

/** Format one evidence turn: a number becomes a Call trace pointer, a string is already one. */
function formatEvidenceTurn(value: number | string | null | undefined, session: string | null): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : formatTraceTurn(value, session);
}

/**
 * Turn observed invite evidence into the scored shape: each spoken line is
 * matched to its VONI turn from the merged excerpt when possible, else the
 * evidence's own turn number. The chip cites the turn that put it up (its
 * own chipTurn, else the first invite line). No turn is ever guessed.
 */
function toEmailInviteEvidence(
  file: EmailInviteEvidenceFile,
  excerpt: string[],
  fallbackSession: string,
): EmailInviteEvidence {
  const traceSession = file.traceSession ?? (fallbackSession || null);
  const derived = excerpt.length > 0 ? traceTurnsForAgentLines(excerpt, file.agentLines) : [];
  const lineTurns = file.agentLines.map((_, index) =>
    formatEvidenceTurn(derived[index] ?? file.lineTurns?.[index] ?? null, traceSession),
  );
  const firstLineTurn = lineTurns.find((turn): turn is string => turn !== null) ?? null;
  const chipTraceTurn = formatEvidenceTurn(file.chipTurn ?? null, traceSession) ?? firstLineTurn;
  return {
    ...(file.tag !== undefined ? { tag: file.tag } : {}),
    agentLines: file.agentLines,
    chipShows: file.chipShows,
    showToolCalls: file.showToolCalls,
    lineTurns,
    chipTraceTurn,
    ...(file.memoryTurn !== undefined ? { memoryTraceTurn: formatEvidenceTurn(file.memoryTurn, traceSession) } : {}),
    ...(file.memoryInvitedBefore !== undefined ? { memoryInvitedBefore: file.memoryInvitedBefore } : {}),
    ...(file.memoryInvitedAfter !== undefined ? { memoryInvitedAfter: file.memoryInvitedAfter } : {}),
    ...(file.tagTokenBefore !== undefined ? { tagTokenBefore: file.tagTokenBefore } : {}),
    ...(file.tagTokenAfter !== undefined ? { tagTokenAfter: file.tagTokenAfter } : {}),
    ...(file.callTokenBefore !== undefined ? { callTokenBefore: file.callTokenBefore } : {}),
    ...(file.callTokenAfter !== undefined ? { callTokenAfter: file.callTokenAfter } : {}),
    ...(file.returning !== undefined ? { returning: file.returning } : {}),
    ...(file.greetedAsReturning !== undefined ? { greetedAsReturning: file.greetedAsReturning } : {}),
    ...(file.freeAddress !== undefined ? { freeAddress: file.freeAddress } : {}),
  };
}

/**
 * The one shared golden recording every ballot judges. `--recording-file`
 * hashes the recording the harness has on disk (the session recording whose
 * sha256 qa-voice-session already reports), so the operator does not retype a
 * 64-char digest; an explicit `--recording` must agree with it. Ballots with
 * neither are rejected: unbound ears never count.
 */
function readRecordingBinding(recording: string, recordingFile: string): string {
  if (!recordingFile) return recording;
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolve(recordingFile));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`--recording-file ${recordingFile}: cannot read the golden recording (${reason})`);
  }
  const fileSha = sha256Hex(bytes);
  if (recording && recording.toLowerCase() !== fileSha) {
    throw new Error(
      `--recording ${recording} does not match --recording-file sha256 ${fileSha} (ballots judge one shared recording)`,
    );
  }
  return fileSha;
}

/**
 * File blind ballots from `--rate rater:timbre,accent` (repeatable) against
 * the shared golden recording (`--recording <sha256>` or
 * `--recording-file <path>`). Ballots without a recording are rejected:
 * unbound ears never count.
 */
function readHumanRatings(rates: string[], recording: string): HumanRatings {
  if (rates.length > 0 && !recording) {
    throw new Error("--rate ballots need --recording <sha256 of the golden recording they judge>");
  }
  if (recording && !/^[0-9a-f]{64}$/i.test(recording)) {
    throw new Error(`--recording needs a sha256 hex digest, got "${recording}"`);
  }
  let slots = emptyHumanRatings(recording || null);
  for (const rate of rates) {
    const match = /^([^:]+):([^,]+),([^,]+)$/.exec(rate.trim());
    if (!match) throw new Error(`--rate needs rater:timbre,accent (ints 1-5), got "${rate}"`);
    slots = addHumanRating(
      slots,
      { rater: match[1].trim(), timbre: Number(match[2]), accent: Number(match[3]) },
      recording,
    );
  }
  return slots;
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function runEvalRunner(voice: string, scenario: string, runs: string): { stdout: string; exitCode: number | null; durationMs: number; evalError: string | null } {
  const started = Date.now();
  const result = spawnSync(
    "npm",
    ["run", "eval:demo-agent", "--", "--voice", voice, "--scenario", scenario, "--runs", runs],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // A spawn failure (missing binary, killed) surfaces as result.error, not
  // an exit code: record it so the artifact marks a harness break.
  const evalError = result.error instanceof Error ? result.error.message : null;
  return { stdout, exitCode: evalError ? null : result.status, durationMs: Date.now() - started, evalError };
}

function runCallTrace(sessionId: string): string[] {
  const result = spawnSync("npm", ["run", "call:trace", "--", sessionId], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`call:trace failed for ${sessionId}: ${(result.stderr ?? "").slice(0, 500)}`);
  }
  return redactLines(result.stdout ?? "");
}

/** Parse a previously written scoreboard artifact; null when the file is not one. */
function readScoreboardArtifact(path: string): ScoreboardArtifact | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ScoreboardArtifact> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.voice !== "string" ||
      !Array.isArray(parsed.gates) ||
      typeof parsed.beats !== "object" ||
      parsed.beats === null ||
      typeof parsed.replyGap !== "object" ||
      parsed.replyGap === null ||
      typeof parsed.endCallDrain !== "object" ||
      parsed.endCallDrain === null
    ) {
      return null;
    }
    return parsed as ScoreboardArtifact;
  } catch {
    return null;
  }
}

/**
 * Latest artifact for the same voice in the artifact directory (the new run's
 * own output path is skipped so a rerun to the same file never diffs against
 * itself). Ties on recordedAt fall back to file mtime, so two runs inside one
 * second still order by when they landed.
 */
function latestPriorArtifact(
  dir: string,
  voice: string,
  skipPath: string,
): { path: string; artifact: ScoreboardArtifact } | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; artifact: ScoreboardArtifact; recorded: number; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = resolve(dir, entry);
    if (path === skipPath) continue;
    const artifact = readScoreboardArtifact(path);
    if (!artifact || artifact.voice !== voice) continue;
    const recorded = Date.parse(artifact.recordedAt);
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      mtime = 0;
    }
    const candidate = {
      path,
      artifact,
      recorded: Number.isFinite(recorded) ? recorded : 0,
      mtime,
    };
    if (
      best === null ||
      candidate.recorded > best.recorded ||
      (candidate.recorded === best.recorded && candidate.mtime > best.mtime)
    ) {
      best = candidate;
    }
  }
  return best ? { path: best.path, artifact: best.artifact } : null;
}

/** Explicit --prior: a bad path or non-artifact is a harness error, never a silent first run. */
function loadPriorArtifact(path: string): { path: string; artifact: ScoreboardArtifact } {
  const resolved = resolve(path);
  const artifact = readScoreboardArtifact(resolved);
  if (!artifact) throw new Error(`--prior ${path} is not a scoreboard artifact`);
  return { path: resolved, artifact };
}

/** Repeatable --gap beat=ms: measured reply gaps per beat (one per run). */
function parseGapFlags(argv: string[]): Partial<Record<GoldenBeat, number[]>> {
  const gaps: Partial<Record<GoldenBeat, number[]>> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--gap") continue;
    const raw = argv[i + 1] ?? "";
    const match = /^([a-z-]+)=(\d+)$/.exec(raw);
    const beat = match?.[1] as GoldenBeat | undefined;
    const ms = match ? Number(match[2]) : NaN;
    if (!match || !(GOLDEN_BEATS as readonly string[]).includes(beat as string) || !Number.isFinite(ms)) {
      throw new Error(
        `--gap needs beat=ms with a golden beat (one of ${GOLDEN_BEATS.join(", ")}), got "${raw}"`,
      );
    }
    gaps[beat as GoldenBeat] = [...(gaps[beat as GoldenBeat] ?? []), ms];
  }
  return gaps;
}

/**
 * Filler-beat evidence from explicit CLI flags (the observed floor behavior
 * for one filler overlap). The verdict defaults to what the overlap judge
 * says about the words; cut/resume/tail observations always come from the
 * run. Absent --filler-text, the filler-resume gate stays INFO (skeleton).
 *
 *   --filler-text "Okaay so" [--filler-agent-text "..."] [--filler-verdict ignore]
 *   [--filler-cut-ms 320] [--filler-resume-ms 1200]
 *   [--filler-resumed-text "..."] [--filler-heard-text "..."]
 *   [--filler-answered-over] [--filler-trace-turn sess_abc#turn]
 *
 * --trace-session fills --filler-trace-turn when the flag is absent, so a
 * failure still points at the Call trace turn.
 */
function readFillerEvidence(traceSession: string): FillerResumeEvidence | undefined {
  const visitorText = arg("--filler-text", "");
  if (!visitorText) return undefined;
  const agentText = arg("--filler-agent-text", "");
  const verdictRaw = arg("--filler-verdict", "");
  const verdict: FillerVerdict = (
    verdictRaw ? verdictRaw : judgeOverlap(visitorText, agentText)
  ) as FillerVerdict;
  if (!["yield", "ignore", "judge", "keep"].includes(verdict)) {
    throw new Error(`--filler-verdict needs one of yield|ignore|judge|keep, got "${verdictRaw}"`);
  }
  const ms = (flag: string): number | null => {
    const raw = arg(flag, "");
    if (raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative ms number, got "${raw}"`);
    return n;
  };
  return {
    visitorText,
    agentText,
    verdict,
    cutMs: ms("--filler-cut-ms"),
    resumeMs: ms("--filler-resume-ms"),
    resumedText: arg("--filler-resumed-text", ""),
    heardText: arg("--filler-heard-text", ""),
    answeredOver: process.argv.includes("--filler-answered-over"),
    traceTurn: arg("--filler-trace-turn", "") || traceSession || undefined,
  };
}

const OVERHEARD_HANDLINGS = ["answered", "resumed-from", "heard-only", "lost"] as const;

/** Load and validate explicit overheard asides; throws (exit 1, no artifact) on bad input. */
function loadOverheardJson(path: string): OverheardAside[] {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`--overheard-json ${path} must be a JSON array of asides`);
  return raw.map((entry, index) => {
    const aside = entry as Partial<OverheardAside>;
    if (aside === null || typeof aside !== "object") {
      throw new Error(`--overheard-json[${index}]: must be an object`);
    }
    if (!(GOLDEN_BEATS as readonly string[]).includes(String(aside.beat))) {
      throw new Error(`--overheard-json[${index}]: beat must be one of ${GOLDEN_BEATS.join(", ")}`);
    }
    if (typeof aside.text !== "string" || !aside.text.trim()) {
      throw new Error(`--overheard-json[${index}]: text must be a non-empty string`);
    }
    if (typeof aside.markedOverheard !== "boolean" || typeof aside.inLedger !== "boolean") {
      throw new Error(`--overheard-json[${index}]: markedOverheard and inLedger must be booleans`);
    }
    if (!(OVERHEARD_HANDLINGS as readonly string[]).includes(String(aside.handling))) {
      throw new Error(`--overheard-json[${index}]: handling must be one of ${OVERHEARD_HANDLINGS.join(", ")}`);
    }
    if (typeof aside.tracePointer !== "string" || !aside.tracePointer.trim()) {
      throw new Error(`--overheard-json[${index}]: tracePointer must be a non-empty string`);
    }
    return {
      beat: aside.beat as GoldenBeat,
      text: aside.text,
      ...(typeof aside.agentText === "string" ? { agentText: aside.agentText } : {}),
      markedOverheard: aside.markedOverheard,
      inLedger: aside.inLedger,
      handling: aside.handling as OverheardAside["handling"],
      tracePointer: aside.tracePointer,
    };
  });
}

/** Comma-separated milliseconds flag; empty means the flag was not given. */
function parseMsList(raw: string, flag: string): number[] {
  if (!raw.trim()) return [];
  const out = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number);
  if (out.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`${flag} needs comma-separated milliseconds >= 0, got "${raw}"`);
  }
  return out;
}

function parseOverlapMs(raw: string): number[] {
  if (!raw) return [];
  const values = raw.split(",").map((part) => Number(part.trim()));
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new Error(`--overlap-ms needs non-negative milliseconds like "120,350", got "${raw}"`);
  }
  return values;
}

function parseOptionalNumber(raw: string, flag: string): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} needs a number, got "${raw}"`);
  }
  return value;
}

/**
 * Dead-air evidence from CLI flags. Returns undefined when no dead-air flag
 * was given, so the gate stays INFO (unmeasured) instead of claiming PASS.
 */
function parseDeadAirEvidence(input: {
  gaps: string;
  longestSilenceMs: string;
  checkInAtMs: string;
  checkInOverCaller: boolean;
  checkInYieldMs: string;
  trace?: string;
}): DeadAirEvidence | undefined {
  const gapsMs = parseMsList(input.gaps, "--dead-air-gaps");
  const checkInAtMs = parseMsList(input.checkInAtMs, "--check-in-at-ms");
  const yields = parseMsList(input.checkInYieldMs, "--check-in-yield-ms");
  if (yields.length > 1) throw new Error("--check-in-yield-ms takes one measured yield, got a list");
  const checkInYieldMs = yields[0];
  let longestSilenceMs: number | null = null;
  if (input.longestSilenceMs.trim()) {
    longestSilenceMs = Number(input.longestSilenceMs);
    if (!Number.isFinite(longestSilenceMs) || longestSilenceMs < 0) {
      throw new Error(`--longest-silence-ms needs milliseconds >= 0, got "${input.longestSilenceMs}"`);
    }
  }
  if (gapsMs.length === 0 && longestSilenceMs === null && checkInAtMs.length === 0) {
    return undefined;
  }
  return {
    gapsMs,
    longestSilenceMs,
    checkIns: checkInAtMs.map((atSilenceMs) => ({
      atSilenceMs,
      overCaller: input.checkInOverCaller,
      ...(checkInYieldMs !== undefined ? { yieldMs: checkInYieldMs } : {}),
    })),
    ...(input.trace ? { trace: input.trace } : {}),
  };
}

/** A documented silence timeline (--silence-json): validated, never guessed. */
function loadSilenceTimeline(path: string): SilenceTimeline {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  } catch (error) {
    throw new Error(`--silence-json ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseSilenceTimeline(raw, `--silence-json ${path}`);
}

/**
 * Turn a session timeline into dead-air evidence: uncovered long silences are
 * gaps, every stretch is recorded with its coverage, and each gap cites the
 * surrounding Call trace turns plus its own window (a silent gap has no row).
 */
function deadAirEvidenceFromTimeline(
  timeline: SilenceTimeline,
  excerpt: string[],
  sessionId: string | null,
): DeadAirEvidence {
  const derived = deriveFreeFloorSilence(timeline);
  const cite = (window: { startMs: number; endMs: number }) => traceSilenceRef(excerpt, window, sessionId);
  const gapWindows: DeadAirSilence[] = derived.gapWindows.map((gap) => ({ ...gap, trace: cite(gap) }));
  return {
    gapsMs: gapWindows.map((gap) => gap.durationMs),
    gapWindows,
    silences: derived.silences.map((silence) => ({ ...silence, trace: cite(silence) })),
    longestSilenceMs: derived.longestSilenceMs,
    checkIns: derived.checkIns.map((checkIn) => {
      if (checkIn.trace || checkIn.atMs === undefined) return checkIn;
      // Cite the turn at the check-in itself: for a second check-in this is
      // where the count went wrong, and an over-caller check-in is the turn
      // the visitor was talked over. A silent stretch has no row of its own.
      const ref = traceCheckInRef(excerpt, checkIn.atMs, sessionId);
      return ref ? { ...checkIn, trace: ref } : checkIn;
    }),
    ...(sessionId ? { trace: sessionId } : {}),
  };
}

function main(): void {
  const voice = resolveGateVoice(arg("--gate-voice", "") || arg("--voice", DEFAULT_GATE_VOICE));
  const scenario = arg("--scenario", "greeting-cut");
  const runs = arg("--runs", "1");
  if (!/^[1-9]\d*$/.test(runs)) {
    throw new Error(`--runs needs a positive int, got "${runs}"`);
  }
  const dryRun = process.argv.includes("--dry-run");
  // Timing runs go one at a time: a live run takes the machine-wide lock
  // before dialing so a parallel run cannot inflate the cut number. A held
  // lock fails fast, names the holder, and writes no artifact. The lock is
  // still taken when the trace session is auto-chained below: the trace
  // merge rides along with the same live run.
  if (!dryRun) {
    acquireTimingLock({ path: arg("--timing-lock", DEFAULT_TIMING_LOCK_PATH), scenario });
  }
  /** Explicit --trace-session: a bad id or a failed merge is a harness break. */
  const requestedTraceSession = arg("--trace-session", "");
  if (requestedTraceSession && !/^sess_[A-Za-z0-9_-]+$/.test(requestedTraceSession)) {
    throw new Error(`--trace-session needs a session id like sess_abc, got "${requestedTraceSession}"`);
  }
  const traceBeatRaw = arg("--trace-beat", "");
  if (traceBeatRaw && !(GOLDEN_BEATS as readonly string[]).includes(traceBeatRaw)) {
    throw new Error(`--trace-beat needs a golden beat (one of ${GOLDEN_BEATS.join(", ")}), got "${traceBeatRaw}"`);
  }
  const explicitDeadAir = parseDeadAirEvidence({
    gaps: arg("--dead-air-gaps", ""),
    longestSilenceMs: arg("--longest-silence-ms", ""),
    checkInAtMs: arg("--check-in-at-ms", ""),
    checkInOverCaller: process.argv.includes("--check-in-over-caller"),
    checkInYieldMs: arg("--check-in-yield-ms", ""),
    trace: requestedTraceSession || undefined,
  });
  const silenceJsonPath = arg("--silence-json", "");
  const cutMsArg = arg("--cut-ms", "");
  if (cutMsArg !== "" && !/^\d+$/.test(cutMsArg)) {
    throw new Error(`--cut-ms needs milliseconds, got "${cutMsArg}"`);
  }
  const overheardJsonPath = arg("--overheard-json", "");
  const emailJsonPath = arg("--email-json", "");
  const probePath = arg("--probe-json", "");
  const { probes: timbreProbes, agentChannel } = probePath
    ? readProbeJson(resolve(probePath))
    : { probes: undefined as TimbreProbes | undefined, agentChannel: undefined as AgentChannelEvidence | null | undefined };
  const humanRatings: HumanRatings = readHumanRatings(
    argAll("--rate"),
    readRecordingBinding(arg("--recording", ""), arg("--recording-file", "")),
  );

  const evalSection = dryRun
    ? { stdout: "(dry run: eval runner skipped)", exitCode: null as number | null, durationMs: 0, evalError: null as string | null }
    : runEvalRunner(voice, scenario, runs);

  // The live runner prints `· trace session sess_…` when the call opens; an
  // explicit --trace-session always wins, otherwise the last live call is
  // chained so per-turn gaps come from the merger, never an estimate.
  const runnerTraceSession = dryRun ? null : extractTraceSessionId(evalSection.stdout);
  const traceSession = requestedTraceSession || runnerTraceSession || "";
  const autoChainedTrace = !requestedTraceSession && runnerTraceSession !== null;

  const gaps = parseGapFlags(process.argv);
  const explicitAsides = overheardJsonPath ? loadOverheardJson(overheardJsonPath) : null;
  let excerpt: string[] | null = null;
  let traceGaps: TraceGap[] = [];
  if (traceSession) {
    if (!autoChainedTrace) {
      excerpt = runCallTrace(traceSession);
    } else {
      // A just-finished session may still be processing its timeline: record
      // the session id and defer the merge instead of breaking the harness or
      // inventing gaps.
      try {
        excerpt = runCallTrace(traceSession);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`call trace merge deferred for ${traceSession}: ${message}`);
        console.log(
          `trace session ${traceSession}: rerun once the timeline finishes with npm run call:trace -- ${traceSession}, then score with --trace-session ${traceSession}`,
        );
      }
    }
    if (excerpt) traceGaps = parseTraceGaps(excerpt);
  }
  // Dead-air producer: the live runner's own session timeline (or a documented
  // --silence-json replay). The explicit --dead-air-* flags stay the override.
  const runnerSilence = dryRun ? null : parseSilenceTimelineOutput(evalSection.stdout);
  const silenceTimeline = silenceJsonPath
    ? loadSilenceTimeline(silenceJsonPath)
    : (runnerSilence?.timeline ?? null);
  const deadAir =
    explicitDeadAir ??
    (silenceTimeline ? deadAirEvidenceFromTimeline(silenceTimeline, excerpt ?? [], traceSession || null) : undefined);
  const traceAsides =
    excerpt && traceSession
      ? overheardFromTraceExcerpt(excerpt, traceSession, "overheard-aside", {
          // The runner's session ledger (`transcript.user` finals) proves the
          // same words were counted, independent of the merged trace.
          ...(dryRun ? {} : { ledger: parseHeardLedgerOutput(evalSection.stdout) ?? undefined }),
        })
      : [];
  const overheardAsides =
    explicitAsides !== null || traceAsides.length > 0 ? [...(explicitAsides ?? []), ...traceAsides] : undefined;
  // Invite/tag/chip evidence: an explicit --email-json (browser probe, replay)
  // wins; otherwise the live runner's own EMAIL INVITE line. Omitted evidence
  // leaves the email gate INFO (unmeasured), never PASS.
  const runnerEmailEvidence = dryRun ? null : parseEmailInviteOutput(evalSection.stdout);
  const emailFile = emailJsonPath ? readEmailInviteJson(resolve(emailJsonPath)) : runnerEmailEvidence;
  const emailEvidence = emailFile ? toEmailInviteEvidence(emailFile, excerpt ?? [], traceSession) : null;
  // The live runner's own DOUBLE TALK line (over-talk) is the producer for
  // the double-talk gate: post-flush residual overlap per cut. An explicit
  // --overlap-ms wins (replay/triage); without either the gate stays INFO.
  const explicitOverlapMs = parseOverlapMs(arg("--overlap-ms", ""));
  const runnerDoubleTalk = dryRun ? null : parseDoubleTalkOutput(evalSection.stdout);
  const doubleTalkOverlapMs = explicitOverlapMs.length > 0 ? explicitOverlapMs : (runnerDoubleTalk?.overlapMs ?? []);
  // The turn pointer may only come from the same call the overlap was heard
  // on. A trace merges the run's last session; when the evidence names another
  // session, cite that session and say no turn was merged instead of pointing
  // at a turn from a different call.
  const doubleTalkTraceRef =
    runnerDoubleTalk?.sessionId && traceSession && runnerDoubleTalk.sessionId !== traceSession
      ? `${runnerDoubleTalk.sessionId} (no turn merged: trace session ${traceSession} is a different call)`
      : undefined;
  const agentInput = buildDemoAgentBody(voice).input;
  // Explicit --filler-* flags are the operator override. Without them, the
  // live runner's own `filler …` line is the observed behavior and scores the
  // gate, so a filler-over run no longer stays INFO until a human retypes it.
  const explicitFiller = readFillerEvidence(traceSession);
  const runnerFiller = explicitFiller || dryRun ? null : parseFillerRunOutput(evalSection.stdout);
  const fillerResume =
    explicitFiller ?? (runnerFiller ? fillerEvidenceFromRun(runnerFiller) ?? undefined : undefined);
  // A filler FAIL must point at the turn whose reply it overlapped: match the
  // merged HEARD row, never the bare session id, when the words appear. A cut
  // points at what the caller actually heard after it: the resume turn when
  // the tail played (reworded tails live there), the interrupted turn when
  // nothing played (the tail was dropped). No merged row is stated explicitly
  // instead of replaced by a guessed turn.
  if (fillerResume && !arg("--filler-trace-turn", "")) {
    const cutObserved = fillerResume.cutMs !== null || fillerResume.cutObserved === true;
    const pointers = excerpt ? traceTurnPointers(excerpt) : { cutTurn: null, answerTurn: null, goodbyeTurn: null };
    const fillerTurn = cutObserved
      ? fillerResume.resumeMs !== null
        ? (pointers.answerTurn ?? pointers.cutTurn)
        : pointers.cutTurn
      : excerpt
        ? traceTurnForVisitorSpeech(excerpt, fillerResume.visitorText)
        : null;
    fillerResume.traceTurn =
      fillerTurn !== null
        ? formatTraceTurn(fillerTurn, traceSession || null)
        : `no turn merged${traceSession ? ` (${traceSession})` : ""}`;
  }
  // The caller clip the live runner actually streamed (ticket 10): a changed
  // clip makes the cut number incomparable with the prior run.
  const callerClips = dryRun ? [] : callerClipsFromRunnerStdout(evalSection.stdout);
  // The prior run is a working artifact, never committed: load it before the
  // cut gate so a changed caller clip fails comparability instead of greening.
  const out = resolve(arg("--out", `scoreboard-runs/score-${stamp()}-${voice}.json`));
  const priorPath = arg("--prior", "");
  const prior = priorPath ? loadPriorArtifact(priorPath) : latestPriorArtifact(dirname(out), voice, out);
  // Real-cut evidence counts as measured even though it lands post-skeleton.
  const parsed = extractRealCutEvidence(evalSection.stdout, excerpt ?? []);
  // Greeting-cut evidence comes from the fixed caller clip's own scenario;
  // score-demo gates the measured ms and cites the interrupted greeting turn.
  const greetingCut = extractGreetingCutEvidence(evalSection.stdout, excerpt ?? [], traceSession || null);
  // Goodbye drain producer: the live runner's GOODBYE DRAIN line (coverage
  // plus whether the closing line named the team inbox) and its own measured
  // hang-up line. Explicit --goodbye-* flags stay the operator override.
  const runnerGoodbye = dryRun ? null : parseGoodbyeDrainOutput(evalSection.stdout);
  const inboxNamedFlagged = process.argv.includes("--goodbye-inbox-named");
  const inboxMissingFlagged = process.argv.includes("--goodbye-inbox-missing");
  if (inboxNamedFlagged && inboxMissingFlagged) {
    throw new Error("--goodbye-inbox-named and --goodbye-inbox-missing contradict each other");
  }
  const goodbyeCoverage =
    parseOptionalNumber(arg("--goodbye-coverage", ""), "--goodbye-coverage") ?? runnerGoodbye?.coverage ?? null;
  const flaggedHangUpMs = parseOptionalNumber(arg("--hang-up-delay-ms", ""), "--hang-up-delay-ms");
  const runnerHangUp = flaggedHangUpMs === null && !dryRun ? parseRunnerHangUp(evalSection.stdout) : null;
  const hangUpDelayMs = flaggedHangUpMs ?? runnerHangUp?.ms ?? null;
  const inboxNamed = inboxMissingFlagged ? false : inboxNamedFlagged ? true : (runnerGoodbye?.inboxNamed ?? null);
  // Post-End call narration: measured by the runner (it hears every reply
  // after its own hang-up signal) or by the merged trace. The explicit flag
  // stays for a human replay; a real run FAILs on its own evidence.
  const narratedEnding =
    process.argv.includes("--narrated-ending") || runnerGoodbye?.narratedEnding === true;
  const goodbyeTraceRef = runnerGoodbye ? goodbyeEvidenceTraceRef(runnerGoodbye, traceSession) : undefined;
  // A hang-up past (or before) the drain window is the measurement that ran
  // long: cite that call's own closing turn, never the GOODBYE DRAIN
  // scenario's turn (a different live call).
  const hangUpRanLong =
    hangUpDelayMs !== null && (hangUpDelayMs < 0 || hangUpDelayMs > HANG_UP_AFTER_GOODBYE_MAX_MS);
  const drainTraceRef =
    runnerHangUp && hangUpRanLong
      ? hangUpEvidenceTraceRef(runnerHangUp, traceSession, excerpt)
      : goodbyeTraceRef;
  const hasCutFlags =
    cutMsArg !== "" ||
    process.argv.includes("--cut-never") ||
    arg("--cut-verdict", "") !== "" ||
    process.argv.includes("--cut-answered") ||
    process.argv.includes("--cut-resumed") ||
    process.argv.includes("--cut-ended") ||
    arg("--trace-turn", "") !== "";

  let artifact: ScoreboardArtifact = buildSkeletonArtifact({
    voice,
    scenario,
    runnerStdout: evalSection.stdout,
    exitCode: evalSection.exitCode,
    durationMs: evalSection.durationMs,
    runs: Number(runs),
    gaps,
    traceGaps,
    ...(traceBeatRaw ? { traceBeat: traceBeatRaw as GoldenBeat } : {}),
    traceSessionId: traceSession || null,
    agentInput,
    traceExcerpt: excerpt ?? [],
    fillerResume,
    ...(overheardAsides !== undefined ? { overheardAsides } : {}),
    deadAir,
    doubleTalkOverlapMs,
    ...(doubleTalkTraceRef ? { doubleTalkTraceRef } : {}),
    endCallDrain: {
      goodbyeCoverage,
      hangUpDelayMs,
      narratedEnding,
      inboxNamed,
    },
    ...(drainTraceRef ? { endCallDrainTraceRef: drainTraceRef } : {}),
    traceRef: traceSession || undefined,
    probes: timbreProbes,
    agentChannel,
    humanRatings,
    dryRun,
    evalError: evalSection.evalError,
    ...(greetingCut ? { greetingCutEvidencePresent: true } : {}),
    ...(parsed || hasCutFlags ? { realCutEvidencePresent: true } : {}),
    callerClips,
    ...(emailEvidence ? { emailInviteEvidencePresent: true } : {}),
    runId: `run-${stamp()}-${voice}`,
    // Ticket 29: the streak compares the exact code, not just the voice.
    codeFingerprint: readCodeFingerprint(),
  });
  if (parsed || hasCutFlags) {
    const base: RealCutEvidence = parsed ?? {
      cutMs: null,
      verdict: null,
      verdictSource: null,
      answered: false,
      resumed: false,
      ended: false,
      traceTurn: null,
    };
    // The merged excerpt is the only source of a turn number: for a measured
    // cut cite the turn after it (the answer, or the resume that must FAIL),
    // else the interrupted reply / closing reply after end_call.
    const pointers = traceTurnPointers(excerpt ?? []);
    const derivedTurn =
      base.cutMs !== null
        ? (pointers.answerTurn ?? pointers.cutTurn)
        : (pointers.cutTurn ?? pointers.goodbyeTurn);
    const derivedTraceTurn =
      derivedTurn !== null ? formatTraceTurn(derivedTurn, traceSession || null) : base.traceTurn;
    const evidence: RealCutEvidence = {
      cutMs: process.argv.includes("--cut-never")
        ? null
        : cutMsArg !== "" ? Number(cutMsArg) : base.cutMs,
      verdict: arg("--cut-verdict", "") || base.verdict,
      verdictSource: base.verdictSource,
      answered: process.argv.includes("--cut-answered") || base.answered,
      resumed: process.argv.includes("--cut-resumed") || base.resumed,
      ended: process.argv.includes("--cut-ended") || base.ended,
      traceTurn: arg("--trace-turn", "") || derivedTraceTurn,
    };
    const clipDrift = prior ? callerClipChanges(prior.artifact.callerClips ?? [], callerClips) : null;
    artifact = applyRealCutGate(artifact, evidence, clipDrift);
  }
  if (greetingCut) {
    artifact = applyGreetingCutGate(artifact, greetingCut);
  }
  if (emailEvidence) {
    artifact = applyEmailInvite(artifact, emailEvidence);
  }
  if (excerpt) {
    artifact.callTrace = {
      sessionId: traceSession,
      excerptSha256: sha256Hex(excerpt.join("\n")),
      excerpt: excerpt.slice(0, 120),
    };
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });

  console.log(formatGoldenScript(voice));
  console.log(formatBudgetReport());
  console.log(formatGateTable(artifact));
  // Plumbing health first (ticket 06), then what moved since the prior run
  // (ticket 07): a harness break explains any diff that follows.
  console.log(formatEvalRunnerReport(artifact));
  if (prior) {
    console.log(`prior artifact: ${prior.path}`);
    console.log(formatArtifactDiff(diffScoreboardArtifact(prior.artifact, artifact)));
  } else {
    console.log(`artifact diff: no prior artifact for ${voice} in ${dirname(out)} (first run)`);
  }
  console.log(formatReplyGapReport(excerpt ?? [], traceSession || null));
  if (!dryRun && !traceSession) {
    console.log("trace session: none printed by the eval runner; pass --trace-session <sess_...> to merge per-turn gaps");
  }
  console.log(formatSubScoreTable(artifact));
  console.log(formatVoiceGainTable(artifact.loudness.voices));
  console.log(formatHumanReview(artifact.humanReview));
  console.log(formatOverheardReport(artifact));
  console.log(`artifact: ${out}`);
  const failures = artifact.gates.filter((gate) => gate.status === "FAIL");
  if (failures.length > 0) {
    // Harness break (plumbing) is distinct from a measured gate FAIL: the
    // numbers were never taken, so triage starts with the harness.
    if (failures.some((gate) => gate.name === "plumbing")) {
      console.log("scoreboard: HARNESS BREAK — the eval runner never finished; fix the harness, not the thresholds");
    } else {
      console.log("scoreboard: FAIL — a measured gate breached its budget; see the failing gate detail above");
    }
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
