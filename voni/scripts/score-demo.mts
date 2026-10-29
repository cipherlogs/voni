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
 * The default (and `--scenario all`, alias `suite`) is the one-command suite:
 * it runs every gate-voice scenario that produces scoreboard evidence, one at
 * a time under one timing lock, and merges each producer's own stdout into
 * one artifact. Every gate reads only its scenario's slice: greeting-cut from
 * greeting-cut, barge-in-cut from stop-over, filler-resume from filler-over
 * (a non-zero scenario still feeds its measured evidence, never INFO),
 * email-invite from invite-tag, double-talk from over-talk, dead-air from
 * silence-check-in, goodbye coverage from bye-audio, and end-call-drain from
 * the worst hang-up paired with that call's own session. Each scenario's Call
 * trace is merged after all runs (retrying a just-closed timeline), its gaps
 * carry their session and the beat the scenario owns, and every FAIL cites
 * its own scenario's session/turn. `--scenario <name>` stays the focused mode
 * for triage/tests.
 * Plumbing and judgment are separate: an eval runner that finished (its
 * summary printed, whatever the exit code) is plumbing PASS even when a
 * scenario or a measured gate FAILs. A spawn failure, a kill, a crash, no
 * summary, a run with no Call trace session, or a run with no agent audio is
 * a harness break (exit 1, plumbing FAIL, evalRunner status failed) — distinct
 * from a measured gate FAIL (exit 1). Live scenario playout is printed as
 * wall clock under `evalRunner.timings` and never folded into a gate.
 * Non-zero exit otherwise means the harness broke: unknown voice, an unknown
 * --scenario name (listed with the valid ones, before any artifact), bad
 * --runs/--gap/--filler/--cut/--overheard-json/--email-json/--dead-air-gaps/--overlap-ms/--goodbye-coverage/--hang-up-delay-ms/--trace-beat flag, spawn failure,
 * or an unwritable artifact.
 *
 *   npm run scoreboard:demo -- [--gate-voice <demo-voice-id>] [--scenario all | <name>] [--runs 1]
 *                           [--transport stored|inline] [--variant turn-window]
 *                           [--turn-windows 400,640,0 | -,-,0]
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
 *                           [--check-in-at-ms 15200] [--check-in-over-caller] [--check-in-yield-ms 900]
 *                           [--silence-json silence.json]
 *                           [--overlap-ms 120,350] [--goodbye-coverage 0.95]
 *                           [--goodbye-inbox-named | --goodbye-inbox-missing]
 *                           [--hang-up-delay-ms 900] [--narrated-ending]
 *                           [--events <path> | --no-events]
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
 * Every measurement run carries the JSONL event stream (client turn marks,
 * cuts, tool calls): without the client marks there is no per-turn latency
 * split, so a baseline would be unmeasured. By default it writes one file per
 * scenario under `<out dir>/.events/<artifact stem>/<scenario>.jsonl` (inside
 * the gitignored `scoreboard-runs/`), created lazily by the runner. A focused
 * run writes `.../<scenario>.jsonl` there too. `--events <path>` stays the
 * override: a focused run writes that file, the suite writes
 * `<path stem>.<scenario>.jsonl` so one process's truncation cannot drop
 * another's stream. `--no-events` restores the old no-stream behaviour for
 * debugging. The stream is telemetry, never a gate input, and a stream that
 * cannot be read only warns — it never fails a gate.
 *
 * --variant turn-window forwards the stored-agent experiment to every runner
 * section (`--variant`, plus `--turn-windows min,max,interruption_delay` when
 * given; `-` omits a part, so rung 3 is `-,-,0`). The same selection also comes
 * from DEMO_AGENT_VARIANT / DEMO_TURN_*, but the flag wins. A typo, windows
 * without the variant, or a variant on `--transport inline` fails before the
 * lock is taken: inline is a debug path and is never measured. Each artifact's
 * run identity records `variant`, `variantKey`, the agent id/fingerprint and
 * the configured `turnWindows`; `scoreboard:inspect` prints them.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  overheardFromRunEvidence,
  overheardFromTraceExcerpt,
  parseEmailInviteOutput,
  parseFillerRunOutput,
  parseGoodbyeDrainOutput,
  parseHeardLedgerOutput,
  parseDoubleTalkOutput,
  parseOverheardAsideOutput,
  parseSilenceTimeline,
  parseSilenceTimelineOutput,
  parseRunnerHangUp,
  parseRunnerMissingGoodbye,
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
import { demoAgentVariantFromEnv, demoTurnWindowsFromEnv, findCachedDemoAgent, readServedDemoAgentBody, type DemoAgentVariant, type DemoTurnWindows } from "../src/lib/demo/stored-agents";
import {
  evalRunnerArgv,
  parseEvalTransport,
  parseEvalTurnWindowsArg,
  parseEvalVariantArg,
  resolveEvalVariantSelection,
  type EvalTransport,
} from "../src/lib/demo/eval-transport";
import { buildRunnerEvidence } from "../src/lib/demo/runner-evidence";
import { readEvalEvents, type EvalEvent } from "../src/lib/demo/eval-events";
import {
  SUITE_SCENARIOS,
  isAllScenarioSelector,
  resolveScenarioName,
} from "../src/lib/demo/scenario-names";
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

function runEvalRunner(
  voice: string,
  scenario: string,
  runs: string,
  options: {
    transport?: EvalTransport | null;
    variant?: DemoAgentVariant | null;
    turnWindows?: DemoTurnWindows | null;
    eventsPath?: string | null;
  } = {},
): { stdout: string; exitCode: number | null; durationMs: number; evalError: string | null } {
  const started = Date.now();
  const result = spawnSync("npm", evalRunnerArgv({ voice, scenario, runs, ...options }), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // A spawn failure (missing binary, killed) surfaces as result.error, not
  // an exit code: record it so the artifact marks a harness break.
  const evalError = result.error instanceof Error ? result.error.message : null;
  return { stdout, exitCode: evalError ? null : result.status, durationMs: Date.now() - started, evalError };
}

/**
 * One event-stream file per suite scenario: the runner's writer truncates on
 * create, so nine processes sharing a path would leave only the last one's
 * lines. `<dir>/run.jsonl` becomes `<dir>/run.greeting-cut.jsonl`, …
 */
function suiteEventsPath(path: string, scenario: string): string {
  const suffix = path.endsWith(".jsonl") ? ".jsonl" : "";
  const stem = suffix ? path.slice(0, -suffix.length) : path;
  return `${stem}.${scenario}${suffix || ".jsonl"}`;
}

/**
 * Where this run's client receipt marks land. Measurement runs default the
 * stream on, scoped to the artifact (`<out dir>/.events/<artifact stem>/`),
 * so every baseline carries the per-turn split. `--events <path>` overrides
 * the location; `--no-events` restores the old no-stream debug path.
 */
type RunEvents =
  | { enabled: false }
  | { enabled: true; explicit: false; dir: string }
  | { enabled: true; explicit: true; path: string };

function resolveRunEvents(argv: readonly string[], outPath: string): RunEvents {
  const eventsIndex = argv.indexOf("--events");
  const noEvents = argv.includes("--no-events");
  if (noEvents && eventsIndex >= 0) {
    throw new Error("--events and --no-events contradict each other");
  }
  if (noEvents) return { enabled: false };
  if (eventsIndex >= 0) {
    const path = argv[eventsIndex + 1] ?? "";
    if (path.trim() === "") throw new Error("--events needs a path, got \"\"");
    return { enabled: true, explicit: true, path };
  }
  const stem = basename(outPath).replace(/\.json$/i, "");
  return { enabled: true, explicit: false, dir: join(dirname(outPath), ".events", stem) };
}

/** This scenario's JSONL; disabled events pass an empty path (no file). */
function runEventsPath(events: RunEvents, scenario: string, suite: boolean): string {
  if (!events.enabled) return "";
  if (events.explicit) return suite ? suiteEventsPath(events.path, scenario) : events.path;
  return join(events.dir, `${scenario}.jsonl`);
}

/**
 * The one-command suite (ticket 01): every gate voice scenario that carries
 * scoreboard evidence, run one at a time. Timing runs are never parallel:
 * the whole suite holds the machine-wide timing lock and each scenario gets
 * its own sequential invocation, so cut latencies stay comparable. The
 * free-gate goodbye path is covered by bye-audio; it is not repeated.
 *
 * The list lives in `src/lib/demo/scenario-names.ts` beside the runner's own
 * registry, so the suite and the runner can never mean different names.
 */

/**
 * Read the run's opt-in client receipt marks for the latency split. The stream
 * is telemetry: a missing or malformed per-scenario file yields no marks (no
 * split) rather than failing the artifact write. A dry run never ran the
 * runner, so it never reads a stale file into a fresh artifact.
 */
function readRunMarks(events: RunEvents, scenario: string, suite: boolean, dryRun: boolean): EvalEvent[] {
  if (!events.enabled || dryRun) return [];
  const names: readonly string[] = suite ? SUITE_SCENARIOS : [scenario];
  const marks: EvalEvent[] = [];
  for (const name of names) {
    const path = runEventsPath(events, name, suite);
    try {
      marks.push(...readEvalEvents(path));
    } catch (error) {
      // A missing stream means no split for that scenario, not a bad run. A
      // stream that exists but cannot be read is telemetry trouble: warn,
      // never fail a gate over it.
      if (existsSync(path)) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`events stream unreadable for ${name}: ${message}`);
      }
    }
  }
  return marks;
}

type EvalSection = {
  stdout: string;
  exitCode: number | null;
  durationMs: number;
  evalError: string | null;
};

type SectionSummary = {
  scenario: string;
  runs: number;
  failures: number;
  scenarios: { name: string; passed: number; runs: number }[];
  traceSessions: string[];
  playout: { scenario: string; run: number; wallClockMs: number }[];
  audioChunks: number | null;
  live: boolean;
  clips?: { text: string; bytes: number; durationMs: number; sha256: string }[];
  /** Transport and agent the evidence came from (newer runners; optional for old ones). */
  transport?: string;
  agentId?: string | null;
  agentFingerprint?: string | null;
  llmModel?: string | null;
  /** Which stored body bound: production | turn-window (ticket 09). */
  variant?: DemoAgentVariant | null;
  variantKey?: string | null;
  turnWindows?: DemoTurnWindows | null;
};

function sectionSummary(stdout: string): SectionSummary | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("EVAL SUMMARY ")) continue;
    try {
      return JSON.parse(line.slice("EVAL SUMMARY ".length)) as SectionSummary;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Merge per-scenario runner sections into one runner stream. Each producer's
 * stdout stays intact under a scenario header so the parsers see only their
 * own scenario; one synthesized EVAL SUMMARY proves the suite finished, and
 * classification/plumbing reads that summary exactly like a focused run.
 */
function mergeSuiteSections(sections: { name: string; section: EvalSection }[], runs: number): EvalSection {
  const summaries = sections.flatMap(({ section }) => {
    const summary = sectionSummary(section.stdout);
    return summary ? [summary] : [];
  });
  const scenarios = summaries.flatMap((summary) => summary.scenarios);
  const traceSessions = [...new Set(summaries.flatMap((summary) => summary.traceSessions))];
  const playout = summaries.flatMap((summary) => summary.playout);
  const clips = summaries.flatMap((summary) => summary.clips ?? []);
  const uniqueClips = clips.filter((clip, index) => clips.findIndex((other) => other.text === clip.text) === index);
  const audioChunks = summaries.some((summary) => summary.audioChunks !== null)
    ? summaries.reduce((sum, summary) => sum + (summary.audioChunks ?? 0), 0)
    : null;
  const failures = summaries.reduce(
    (sum, summary) => sum + (Number.isFinite(summary.failures) ? summary.failures : 0),
    0,
  );
  // Which agent/model the suite bound, carried through so a merged artifact
  // can still prove the fast-model stored agent produced its evidence. A
  // stored section wins if the suite ever mixed transports.
  const bound = summaries.find((summary) => summary.transport === "stored") ?? summaries.find((summary) => summary.transport);
  // One suite is one experiment: sections that disagree about the stored-agent
  // variant would make the artifact's identity a half-truth, so refuse loudly.
  const boundVariants = new Set(
    summaries.map((summary) =>
      JSON.stringify({
        variant: summary.variant ?? null,
        variantKey: summary.variantKey ?? null,
        turnWindows: summary.turnWindows ?? null,
      }),
    ),
  );
  if (boundVariants.size > 1) {
    throw new Error(
      `suite sections bound different stored-agent variants: ${[...boundVariants].join(" vs ")}`,
    );
  }
  const merged = {
    scenario: "suite",
    runs,
    failures,
    scenarios,
    traceSessions,
    playout,
    audioChunks,
    live: summaries.some((summary) => summary.live),
    ...(bound
      ? {
          transport: bound.transport,
          agentId: bound.agentId ?? null,
          agentFingerprint: bound.agentFingerprint ?? null,
          llmModel: bound.llmModel ?? "managed",
        }
      : {}),
    ...(bound?.variant !== undefined
      ? {
          variant: bound.variant,
          variantKey: bound.variantKey ?? null,
          ...(bound.turnWindows ? { turnWindows: bound.turnWindows } : {}),
        }
      : {}),
    ...(uniqueClips.length > 0 ? { clips: uniqueClips } : {}),
  };
  const stdout = [
    ...sections.map(({ name, section }) => `## scenario ${name}\n${section.stdout.trimEnd()}`),
    `EVAL SUMMARY ${JSON.stringify(merged)}`,
  ].join("\n");
  return {
    stdout,
    exitCode: sections.some(({ section }) => section.exitCode !== 0) ? 1 : 0,
    durationMs: sections.reduce((sum, { section }) => sum + section.durationMs, 0),
    evalError: sections.find(({ section }) => section.evalError)?.section.evalError ?? null,
  };
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

/** Block the (single-threaded) suite while a just-closed timeline finishes. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The suite's readiness gate: a session that closed seconds ago may not have
 * its timeline artifact yet ("No timeline yet"). Retry a few times instead of
 * deferring the whole merge; the caller still records a deferral when the
 * timeline never arrives, never invented gaps.
 */
function runCallTraceWhenReady(sessionId: string, attempts = 6, waitMs = 2500): string[] {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runCallTrace(sessionId);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepSync(waitMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

async function main(): Promise<void> {
  const voice = resolveGateVoice(arg("--gate-voice", "") || arg("--voice", DEFAULT_GATE_VOICE));
  // Default is the full gate suite: a plain `npm run scoreboard:demo` must
  // exercise every gate, not leave most of them INFO on one focused scenario.
  // A misspelt focused name is a named failure here — before the timing lock,
  // before any runner spawn and before the artifact path is opened — so a typo
  // can never write a passing artifact that measured nothing.
  const requestedScenario = arg("--scenario", "all");
  const suite = isAllScenarioSelector(requestedScenario);
  const scenario = suite ? "suite" : resolveScenarioName(requestedScenario);
  const runs = arg("--runs", "1");
  if (!/^[1-9]\d*$/.test(runs)) {
    throw new Error(`--runs needs a positive int, got "${runs}"`);
  }
  // Resolve the artifact before the runners start: the default event stream is
  // scoped to it, so this run's split lands beside — and travels with — the
  // artifact it measured.
  const out = resolve(arg("--out", `scoreboard-runs/score-${stamp()}-${voice}.json`));
  const dryRun = process.argv.includes("--dry-run");
  const events = resolveRunEvents(process.argv, out);
  // Which transport/agent the suite measures. Defaults are untouched (no
  // extra flags reach the runner); a typo, windows without the variant, or a
  // variant on the inline debug path fails here, before the timing lock and
  // before any audio is spent — never a silent fallback to production.
  const transport = parseEvalTransport(process.argv);
  const transportExplicit = process.argv.includes("--transport");
  const variantFlag = parseEvalVariantArg(process.argv);
  const turnWindowsFlag = parseEvalTurnWindowsArg(process.argv);
  const selection = resolveEvalVariantSelection({
    argv: process.argv,
    transport,
    voiceId: voice,
    envVariant: await demoAgentVariantFromEnv(),
    envWindows: await demoTurnWindowsFromEnv(),
  });
  const runnerOptions = {
    ...(transportExplicit ? { transport } : {}),
    ...(variantFlag ? { variant: variantFlag } : {}),
    ...(turnWindowsFlag ? { turnWindows: turnWindowsFlag } : {}),
  };
  if (selection.variant !== "production") {
    console.log(
      `variant: ${selection.variant} ${selection.variantKey} windows ${JSON.stringify(selection.turnWindows)} (source ${selection.source})`,
    );
  }
  // Runner event stream (telemetry, never a gate input). Measurement runs
  // carry it by default so the per-turn split always exists; --no-events is
  // the debug escape hatch.
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

  /** Per-scenario stdout: every evidence parser reads only its own producer. */
  const stdoutByScenario = new Map<string, string>();
  let evalSection: EvalSection;
  if (dryRun) {
    evalSection = { stdout: "(dry run: eval runner skipped)", exitCode: null, durationMs: 0, evalError: null };
  } else if (suite) {
    const sections: { name: string; section: EvalSection }[] = [];
    for (const name of SUITE_SCENARIOS) {
      // One at a time: a timing run in parallel inflates the cut number.
      const section = runEvalRunner(voice, name, runs, {
        ...runnerOptions,
        eventsPath: runEventsPath(events, name, true),
      });
      sections.push({ name, section });
      stdoutByScenario.set(name, section.stdout);
    }
    evalSection = mergeSuiteSections(sections, Number(runs));
  } else {
    evalSection = runEvalRunner(voice, scenario, runs, { ...runnerOptions, eventsPath: runEventsPath(events, scenario, false) });
    stdoutByScenario.set(scenario, evalSection.stdout);
  }
  // Focused mode has one runner stream: every parser reads it verbatim, so a
  // documented replay that names a different scenario still parses. Suite
  // mode hands each parser only its own producer's stdout.
  const scenarioStdout = (...names: string[]): string =>
    suite ? names.map((name) => stdoutByScenario.get(name) ?? "").filter(Boolean).join("\n") : evalSection.stdout;

  // The live runner prints `· trace session sess_…` when each call opens. A
  // suite merges every scenario's own finished call: turn numbers restart at
  // 1 in each, so gaps carry their session, and a scenario's trace is
  // attributed to the beat that scenario owns. Focused mode keeps the one
  // stream (explicit --trace-session wins; otherwise the last live call).
  type MergedTrace = { sessionId: string; excerpt: string[] };
  const tracesBySession = new Map<string, MergedTrace>();
  const traceByScenario = new Map<string, MergedTrace>();
  const traceForScenario = (name: string): MergedTrace | null => traceByScenario.get(name) ?? null;
  let excerpt: string[] | null = null;
  let traceGaps: TraceGap[] = [];
  let traceSession = "";
  if (suite) {
    // A just-closed session may still be processing its timeline: the suite
    // retries (the last call is seconds old), and each scenario's own trace
    // is merged independently, so one late timeline never drops the rest.
    for (const name of SUITE_SCENARIOS) {
      const sectionStdout = stdoutByScenario.get(name) ?? "";
      const sessionId = dryRun ? null : extractTraceSessionId(sectionStdout);
      if (!sessionId) continue;
      let trace = tracesBySession.get(sessionId);
      if (!trace) {
        try {
          trace = { sessionId, excerpt: runCallTraceWhenReady(sessionId) };
          tracesBySession.set(sessionId, trace);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`call trace merge deferred for ${name} (${sessionId}): ${message}`);
          continue;
        }
      }
      traceByScenario.set(name, trace);
    }
    // The golden call opens with the greeting cut: its trace is the primary
    // artifact excerpt (drain narration and turn pointers read one call).
    // An explicit --trace-session still wins for that primary excerpt.
    const primary = traceForScenario("greeting-cut") ?? tracesBySession.values().next().value ?? null;
    excerpt = primary?.excerpt ?? null;
    traceSession = primary?.sessionId ?? "";
    if (requestedTraceSession) {
      excerpt = runCallTrace(requestedTraceSession);
      traceSession = requestedTraceSession;
    }
    const mergedSessions = new Set<string>();
    const TRACE_BEAT_BY_SCENARIO: Partial<Record<(typeof SUITE_SCENARIOS)[number], GoldenBeat>> = {
      "greeting-cut": "greeting-cut",
      "filler-over": "filler-ignored",
      "stop-over": "real-cut-answered",
      "over-talk": "overheard-aside",
      "silence-check-in": "silence-check-in",
      "invite-tag": "email-invite",
      "bye-audio": "goodbye-drain",
    };
    for (const name of SUITE_SCENARIOS) {
      const trace = traceForScenario(name);
      if (!trace || mergedSessions.has(trace.sessionId)) continue;
      mergedSessions.add(trace.sessionId);
      const beat = TRACE_BEAT_BY_SCENARIO[name];
      for (const gap of parseTraceGaps(trace.excerpt)) {
        traceGaps.push({
          gapMs: gap.gapMs,
          turnIndex: gap.turnIndex,
          sessionId: trace.sessionId,
          ...(beat ? { beat } : {}),
        });
      }
    }
  } else {
    const runnerTraceSession = dryRun ? null : extractTraceSessionId(evalSection.stdout);
    traceSession = requestedTraceSession || runnerTraceSession || "";
    const autoChainedTrace = !requestedTraceSession && runnerTraceSession !== null;
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
      if (excerpt) traceGaps = parseTraceGaps(excerpt).map((gap) => ({ ...gap, sessionId: traceSession }));
    }
  }
  const gaps = parseGapFlags(process.argv);
  const explicitAsides = overheardJsonPath ? loadOverheardJson(overheardJsonPath) : null;
  // Dead-air producer: the live runner's own session timeline (or a documented
  // --silence-json replay). The explicit --dead-air-* flags stay the override.
  // Its check-in and silence pointers come from the silence-check-in call.
  const runnerSilence = dryRun ? null : parseSilenceTimelineOutput(scenarioStdout("silence-check-in"));
  const silenceTimeline = silenceJsonPath
    ? loadSilenceTimeline(silenceJsonPath)
    : (runnerSilence?.timeline ?? null);
  const silenceTrace = traceForScenario("silence-check-in");
  const deadAir =
    explicitDeadAir ??
    (silenceTimeline
      ? deadAirEvidenceFromTimeline(
          silenceTimeline,
          silenceTrace?.excerpt ?? excerpt ?? [],
          (silenceTrace?.sessionId ?? traceSession) || null,
        )
      : undefined);
  // Overheard asides come from the over-talk call's own words and ledger.
  const asideTrace = traceForScenario("over-talk");
  const overTalkLedger = dryRun ? null : parseHeardLedgerOutput(scenarioStdout("over-talk"));
  const traceAsides =
    asideTrace
      ? overheardFromTraceExcerpt(asideTrace.excerpt, asideTrace.sessionId, "overheard-aside", {
          // The runner's session ledger (`transcript.user` finals) proves the
          // same words were counted, independent of the merged trace.
          ...(dryRun ? {} : { ledger: overTalkLedger ?? undefined }),
        })
      : excerpt && traceSession
        ? overheardFromTraceExcerpt(excerpt, traceSession, "overheard-aside", {
            ...(dryRun ? {} : { ledger: overTalkLedger ?? undefined }),
          })
        : [];
  // Fallback: the runner's own asserted marker (printed only when it measured
  // a sounding reply cut at/after the caller's start). Used only when the
  // merged trace yields no aside, so it cannot mask a trace regression. The
  // ledger still has to count the words, or the gate FAILs honestly.
  const runnerAside = dryRun ? null : parseOverheardAsideOutput(scenarioStdout("over-talk"));
  const runAsides = runnerAside
    ? overheardFromRunEvidence(runnerAside, "overheard-aside", overTalkLedger ?? undefined)
    : [];
  const observedAsides = traceAsides.length > 0 ? traceAsides : runAsides;
  const overheardAsides =
    explicitAsides !== null || observedAsides.length > 0
      ? [...(explicitAsides ?? []), ...observedAsides]
      : undefined;
  // Invite/tag/chip evidence: an explicit --email-json (browser probe, replay)
  // wins; otherwise the live runner's own EMAIL INVITE line. Omitted evidence
  // leaves the email gate INFO (unmeasured), never PASS.
  const runnerEmailEvidence = dryRun ? null : parseEmailInviteOutput(scenarioStdout("invite-tag"));
  const emailFile = emailJsonPath ? readEmailInviteJson(resolve(emailJsonPath)) : runnerEmailEvidence;
  // The invite's own call supplies its line turns, so a FAIL cites the invite
  // turn of the call that repeated it.
  const inviteTrace = traceForScenario("invite-tag");
  const emailEvidence = emailFile
    ? toEmailInviteEvidence(emailFile, inviteTrace?.excerpt ?? excerpt ?? [], inviteTrace?.sessionId ?? traceSession)
    : null;
  // The live runner's own DOUBLE TALK line (over-talk) is the producer for
  // the double-talk gate: post-flush residual overlap per cut. An explicit
  // --overlap-ms wins (replay/triage); without either the gate stays INFO.
  const explicitOverlapMs = parseOverlapMs(arg("--overlap-ms", ""));
  const runnerDoubleTalk = dryRun ? null : parseDoubleTalkOutput(scenarioStdout("over-talk"));
  const doubleTalkOverlapMs = explicitOverlapMs.length > 0 ? explicitOverlapMs : (runnerDoubleTalk?.overlapMs ?? []);
  // The turn pointer may only come from the same call the overlap was heard
  // on: the over-talk trace when merged, else the evidence's own session.
  const overTalkTrace = traceForScenario("over-talk");
  const doubleTalkTraceRef = (() => {
    const session = runnerDoubleTalk?.sessionId ?? overTalkTrace?.sessionId ?? null;
    if (!session) return undefined;
    const trace = tracesBySession.get(session) ?? overTalkTrace;
    if (trace) {
      const turn = traceTurnPointers(trace.excerpt).cutTurn;
      return turn !== null ? formatTraceTurn(turn, trace.sessionId) : `no turn merged (${trace.sessionId})`;
    }
    return traceSession && session !== traceSession
      ? `${session} (no turn merged: trace session ${traceSession} is a different call)`
      : undefined;
  })();
  // Explicit --filler-* flags are the operator override. Without them, the
  // live runner's own `filler …` line is the observed behavior and scores the
  // gate, so a filler-over run no longer stays INFO until a human retypes it.
  const explicitFiller = readFillerEvidence(traceSession);
  const runnerFiller = explicitFiller || dryRun ? null : parseFillerRunOutput(scenarioStdout("filler-over"));
  const fillerResume =
    explicitFiller ?? (runnerFiller ? fillerEvidenceFromRun(runnerFiller) ?? undefined : undefined);
  // A filler FAIL must point at the turn whose reply it overlapped: match the
  // merged HEARD row, never the bare session id, when the words appear. A cut
  // points at what the caller actually heard after it: the resume turn when
  // the tail played (reworded tails live there), the interrupted turn when
  // nothing played (the tail was dropped). No merged row is stated explicitly
  // instead of replaced by a guessed turn.
  const fillerTrace = traceForScenario("filler-over");
  const fillerExcerpt = fillerTrace?.excerpt ?? excerpt;
  const fillerSession = fillerTrace?.sessionId ?? traceSession;
  if (fillerResume && !arg("--filler-trace-turn", "")) {
    const cutObserved = fillerResume.cutMs !== null || fillerResume.cutObserved === true;
    const pointers = fillerExcerpt
      ? traceTurnPointers(fillerExcerpt)
      : { cutTurn: null, answerTurn: null, goodbyeTurn: null };
    const fillerTurn = cutObserved
      ? fillerResume.resumeMs !== null
        ? (pointers.answerTurn ?? pointers.cutTurn)
        : pointers.cutTurn
      : fillerExcerpt
        ? traceTurnForVisitorSpeech(fillerExcerpt, fillerResume.visitorText)
        : null;
    fillerResume.traceTurn =
      fillerTurn !== null
        ? formatTraceTurn(fillerTurn, fillerSession || null)
        : `no turn merged${fillerSession ? ` (${fillerSession})` : ""}`;
  }
  // The caller clip the live runner actually streamed (ticket 10): a changed
  // clip makes the cut number incomparable with the prior run.
  const callerClips = dryRun ? [] : callerClipsFromRunnerStdout(evalSection.stdout);
  // The prior run is a working artifact, never committed: load it before the
  // cut gate so a changed caller clip fails comparability instead of greening.
  const priorPath = arg("--prior", "");
  const prior = priorPath ? loadPriorArtifact(priorPath) : latestPriorArtifact(dirname(out), voice, out);
  // Real-cut evidence counts as measured even though it lands post-skeleton.
  // The stop-over call's own trace names the answer (or resume) turn.
  const stopTrace = traceForScenario("stop-over");
  const stopExcerpt = stopTrace?.excerpt ?? excerpt ?? [];
  const parsed = extractRealCutEvidence(scenarioStdout("stop-over"), stopExcerpt);
  // Greeting-cut evidence comes from the fixed caller clip's own scenario;
  // score-demo gates the measured ms and cites the interrupted greeting turn.
  const greetingTrace = traceForScenario("greeting-cut");
  const greetingCut = extractGreetingCutEvidence(
    scenarioStdout("greeting-cut"),
    greetingTrace?.excerpt ?? excerpt ?? [],
    (greetingTrace?.sessionId ?? traceSession) || null,
  );
  // Goodbye drain producer: the live runner's GOODBYE DRAIN line (coverage
  // plus whether the closing line named the team inbox) and its own measured
  // hang-up line. Explicit --goodbye-* flags stay the operator override.
  const runnerGoodbye = dryRun ? null : parseGoodbyeDrainOutput(scenarioStdout("bye-audio"));
  const inboxNamedFlagged = process.argv.includes("--goodbye-inbox-named");
  const inboxMissingFlagged = process.argv.includes("--goodbye-inbox-missing");
  if (inboxNamedFlagged && inboxMissingFlagged) {
    throw new Error("--goodbye-inbox-named and --goodbye-inbox-missing contradict each other");
  }
  const goodbyeCoverage =
    parseOptionalNumber(arg("--goodbye-coverage", ""), "--goodbye-coverage") ?? runnerGoodbye?.coverage ?? null;
  const flaggedHangUpMs = parseOptionalNumber(arg("--hang-up-delay-ms", ""), "--hang-up-delay-ms");
  // Both hang-up paths are measured on their own call; the worst one (negative
  // first, then the largest delay) is the row the gate judges, and its own
  // session is the one a FAIL cites. A run whose caller heard no goodbye after
  // the request is measured evidence of a missing closing line, never a
  // silent INFO or a drain measured from the greeting.
  let runnerHangUp: RunnerHangUpEvidence | null = null;
  let hangUpScenarioName: string | null = null;
  let missingGoodbye: { sessionId: string | null } | null = null;
  let missingScenarioName: string | null = null;
  if (flaggedHangUpMs === null && !dryRun) {
    const hangUpNames = suite
      ? (["hang-up-fast", "hang-up-over"] as const)
      : [scenario];
    for (const name of hangUpNames) {
      const sectionStdout = scenarioStdout(name);
      const missing = parseRunnerMissingGoodbye(sectionStdout);
      if (missing) {
        missingGoodbye = missing;
        missingScenarioName = name;
      }
      const evidence = parseRunnerHangUp(sectionStdout);
      if (
        evidence &&
        (runnerHangUp === null ||
          (evidence.ms < 0 && (runnerHangUp.ms >= 0 || evidence.ms < runnerHangUp.ms)) ||
          (evidence.ms >= 0 && runnerHangUp.ms >= 0 && evidence.ms > runnerHangUp.ms))
      ) {
        runnerHangUp = evidence;
        if (!missingGoodbye) hangUpScenarioName = name;
      }
    }
  }
  const hangUpDelayMs = flaggedHangUpMs ?? runnerHangUp?.ms ?? null;
  const inboxNamed = inboxMissingFlagged ? false : inboxNamedFlagged ? true : (runnerGoodbye?.inboxNamed ?? null);
  // Post-End call narration: measured by the runner (it hears every reply
  // after its own hang-up signal) or by the merged trace. The explicit flag
  // stays for a human replay; a real run FAILs on its own evidence.
  const narratedEnding =
    process.argv.includes("--narrated-ending") || runnerGoodbye?.narratedEnding === true;
  const byeTrace = traceForScenario("bye-audio");
  // The suite's primary excerpt is the greeting call, so the bye-audio trace's
  // own post-End row is checked here (the focused run already merges it).
  const byeNarrationTurn = byeTrace ? traceTurnPointers(byeTrace.excerpt).narrationTurn : null;
  const narratedFromByeTrace = suite && byeNarrationTurn !== null;
  const goodbyeTraceRef = runnerGoodbye
    ? goodbyeEvidenceTraceRef(runnerGoodbye, byeTrace?.sessionId ?? traceSession)
    : undefined;
  // A narration FAIL from the bye-audio runner cites that call's post-End turn
  // (or says no turn was merged in THAT call), never another call's turn.
  const byeNarrationRef =
    narratedEnding || narratedFromByeTrace
      ? (() => {
          const session = byeTrace?.sessionId ?? runnerGoodbye?.sessionId ?? null;
          const byeExcerpt = byeTrace?.excerpt ?? excerpt;
          const turn = byeNarrationTurn ?? (byeExcerpt ? traceTurnPointers(byeExcerpt).narrationTurn : null);
          if (turn !== null && session) return formatTraceTurn(turn, session);
          return session ? `no turn merged (${session})` : "no Call trace turn merged";
        })()
      : undefined;
  // A hang-up past (or before) the drain window is the measurement that ran
  // long: cite that call's own closing turn, never another call's turn.
  const hangUpRanLong =
    hangUpDelayMs !== null && (hangUpDelayMs < 0 || hangUpDelayMs > HANG_UP_AFTER_GOODBYE_MAX_MS);
  const hangUpTraceName = missingScenarioName ?? hangUpScenarioName;
  const hangUpTrace = hangUpTraceName ? traceForScenario(hangUpTraceName) : null;
  const hangUpTraceRef = (() => {
    if (missingGoodbye) {
      const session = missingGoodbye.sessionId ?? hangUpTrace?.sessionId ?? null;
      const turn = hangUpTrace ? traceTurnPointers(hangUpTrace.excerpt).goodbyeTurn : null;
      return turn !== null && session
        ? formatTraceTurn(turn, session)
        : session
          ? `${session} (no closing turn merged)`
          : "no Call trace turn merged";
    }
    if (runnerHangUp && hangUpRanLong) {
      return hangUpEvidenceTraceRef(
        runnerHangUp,
        hangUpTrace?.sessionId ?? traceSession,
        hangUpTrace?.excerpt ?? excerpt,
      );
    }
    return goodbyeTraceRef;
  })();
  const drainTraceRef = missingGoodbye ? hangUpTraceRef : (byeNarrationRef ?? hangUpTraceRef);
  const hasCutFlags =
    cutMsArg !== "" ||
    process.argv.includes("--cut-never") ||
    arg("--cut-verdict", "") !== "" ||
    process.argv.includes("--cut-answered") ||
    process.argv.includes("--cut-resumed") ||
    process.argv.includes("--cut-ended") ||
    arg("--trace-turn", "") !== "";

  // Retro #2: reduce the run's own markers and merged traces to typed,
  // PII-safe evidence. Additive: the redacted transcripts stay as they are,
  // and the gates keep reading their own existing fields.
  const evidenceExcerpts = [...tracesBySession.values()].map((trace) => ({
    sessionId: trace.sessionId,
    excerpt: trace.excerpt,
  }));
  if (traceSession && excerpt && !evidenceExcerpts.some((trace) => trace.sessionId === traceSession)) {
    evidenceExcerpts.push({ sessionId: traceSession, excerpt });
  }
  const runnerEvidence = buildRunnerEvidence({
    runnerStdout: evalSection.stdout,
    excerpts: evidenceExcerpts,
    // The marks ride this run's stream; --no-events claims no split, and every
    // gate reads exactly what it read before.
    marks: readRunMarks(events, scenario, suite, dryRun),
  });
  // Voice-parity ticket 20: gates read the stored body a visitor's session
  // actually binds, read back from the platform — never `buildDemoAgentBody`,
  // which describes the body the harness intended to store rather than the
  // copy the platform serves (a failed refresh or stray override differs).
  // A variant run still verdicts the production body (ticket 10), so it reads
  // the cached production row; an unreadable body stays unmeasured (INFO).
  const cachedProduction =
    selection.variant === "production" ? null : await findCachedDemoAgent(voice);
  const servedAgentId =
    selection.variant === "production"
      ? (runnerEvidence?.agentId ?? null)
      : (cachedProduction?.agentId ?? null);
  const servedAgentFingerprint =
    selection.variant === "production"
      ? (runnerEvidence?.agentFingerprint ?? null)
      : (cachedProduction?.fingerprint ?? null);
  const servedRead =
    dryRun || !servedAgentId ? null : await readServedDemoAgentBody(servedAgentId);
  if (servedRead && !servedRead.ok) {
    console.warn(
      `[scoreboard] stored body unmeasured: ${servedRead.error} (end-of-turn and the level leg stay unmeasured, never a reconstruction)`,
    );
  }
  const servedAgentBody =
    servedRead?.ok && servedAgentId
      ? { ...servedRead.body, fingerprint: servedAgentFingerprint }
      : undefined;
  // Ticket 10: the gate keeps checking the production body (read above from
  // the platform, never rebuilt), so a variant run cannot loosen the ADR-0003
  // contract. The experiment's windows are labelled alongside it instead of
  // replacing it; the bound agent id lets the gate tell the variant's own
  // CONFIG rows from production.
  const endOfTurnExperiment =
    selection.variant === "turn-window"
      ? {
          variant: selection.variant,
          variantKey: selection.variantKey,
          turnWindows: selection.turnWindows,
          agentId: runnerEvidence?.agentId ?? null,
        }
      : null;
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
    servedAgentBody,
    ...(endOfTurnExperiment ? { endOfTurnExperiment } : {}),
    traceExcerpt: excerpt ?? [],
    fillerResume,
    ...(overheardAsides !== undefined ? { overheardAsides } : {}),
    deadAir,
    doubleTalkOverlapMs,
    ...(doubleTalkTraceRef ? { doubleTalkTraceRef } : {}),
    endCallDrain: {
      goodbyeCoverage,
      hangUpDelayMs,
      narratedEnding: narratedEnding || narratedFromByeTrace,
      inboxNamed,
      ...(missingGoodbye ? { missingGoodbye: true } : {}),
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
    runnerEvidence,
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
    // The stop-over call's own trace is the only source of a turn number: for
    // a measured cut cite the turn after it (the answer, or the resume that
    // must FAIL), else the interrupted reply / closing reply after end_call.
    const realCutExcerpt = stopTrace?.excerpt ?? excerpt ?? [];
    const realCutSession = stopTrace?.sessionId ?? traceSession;
    const pointers = traceTurnPointers(realCutExcerpt);
    const derivedTurn =
      base.cutMs !== null
        ? (pointers.answerTurn ?? pointers.cutTurn)
        : (pointers.cutTurn ?? pointers.goodbyeTurn);
    const derivedTraceTurn =
      derivedTurn !== null
        ? formatTraceTurn(derivedTurn, realCutSession || null)
        : base.traceTurn && realCutSession
          ? `${base.traceTurn} (${realCutSession})`
          : base.traceTurn;
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
    const merged = [...tracesBySession.values()];
    artifact.callTrace = {
      sessionId: traceSession,
      excerptSha256: sha256Hex(excerpt.join("\n")),
      excerpt: excerpt.slice(0, 120),
      ...(merged.length > 1
        ? {
            sessions: merged.map((trace) => ({
              sessionId: trace.sessionId,
              excerptSha256: sha256Hex(trace.excerpt.join("\n")),
              excerpt: trace.excerpt.slice(0, 120),
            })),
          }
        : {}),
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
  if (suite) {
    // One per-turn block per merged call; turn numbers restart in each, so
    // the session names the call to replay.
    for (const trace of tracesBySession.values()) {
      const gapsForCall = parseTraceGaps(trace.excerpt);
      if (gapsForCall.length === 0) continue;
      console.log(formatReplyGapReport(trace.excerpt, trace.sessionId));
    }
    if (tracesBySession.size === 0) {
      console.log("reply gap per turn (suite: no Call trace merged yet)");
    }
  } else {
    console.log(formatReplyGapReport(excerpt ?? [], traceSession || null));
  }
  if (!dryRun && !traceSession && tracesBySession.size === 0) {
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
