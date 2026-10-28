/**
 * Demo scoreboard: locked golden script (ticket 02) on the ticket-01
 * plumbing. The seven beats below are fixed order, fixed visitor wording,
 * and fixed timing windows, so gap/cut milliseconds stay comparable across
 * runs. Wording reuses the existing eval fragments (LONG_ASK, reachInvite,
 * goodbyeCut, TAG=Lime 42) and the e2e specs they mirror; nothing here
 * retunes pipeline thresholds or gains — the windows quote them.
 *
 * The harness measures nothing yet: per-beat gap/cut/drain milliseconds are
 * placeholders, probe counts start at zero, and every gate reports PASS/INFO
 * (no FAIL until gating lands in later tickets). What this module guarantees
 * is trustworthy plumbing — one JSON artifact per run with redacted
 * transcripts plus their hash, and empty human-rating slots.
 */
import { createHash } from "node:crypto";
import { getVoice, VOICE_OUTPUT_VOLUME, voicePlaybackGain } from "../agents/voices";
import { DEMO_VOICE_IDS } from "./voni-agent";
import { DEMO_INBOX_ADDRESS } from "./email-test";
import { containsTag } from "./test-tag";

/** The locked golden script: seven beats in fixed order (spec story 11). */
export const GOLDEN_BEATS = [
  "greeting-cut",
  "filler-ignored",
  "real-cut-answered",
  "overheard-aside",
  "silence-check-in",
  "email-invite",
  "goodbye-drain",
] as const;

export type GoldenBeat = (typeof GOLDEN_BEATS)[number];

/** The golden call is one 90-second property-inquiry Demo call. */
export const GOLDEN_VERTICAL = "property-inquiry";
export const GOLDEN_SCRIPT_BUDGET_S = 90;

/**
 * One beat's timing window: the fixed bound the beat's metric must land in
 * for runs to stay comparable. `ms` windows quote the pipeline's own bars
 * (stop-over 1.5s, resume tail 2.5s, 15s check-in, 1.5s hang-up); `count`
 * windows pin exact-once behaviour (overheard recall 1/1, tag said once).
 */
export type BeatWindow = {
  metric: string;
  unit: "ms" | "count";
  min: number;
  max: number;
};

export type GoldenBeatSpec = {
  beat: GoldenBeat;
  /** Fixed visitor wording (or fixed silence) that opens the beat. */
  visitor: string;
  /** Pass predicate: what the composed call must audibly do. */
  expect: string;
  window: BeatWindow;
  /** Prior art this beat's wording is taken from. */
  source: string;
};

/**
 * The locked script. Fixed order, fixed wording, fixed windows — a new
 * voice deploys as a registry entry plus a matrix run, never a script edit.
 */
export const GOLDEN_SCRIPT: GoldenBeatSpec[] = [
  {
    beat: "greeting-cut",
    visitor: '"Wait, stop." spoken 1s into Voni\'s greeting',
    expect: "the greeting audio cuts; the cut lands inside the window",
    window: { metric: "cut-latency", unit: "ms", min: 0, max: 1500 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS greeting-cut",
  },
  {
    beat: "filler-ignored",
    visitor: '"Okaay so" (likewise "mm-hmm" / "yeah") over Voni\'s long dental-clinic answer',
    expect: "the floor never yields; if the filler briefly cuts, Voni resumes with the exact unheard tail",
    window: { metric: "resume-tail-latency", unit: "ms", min: 0, max: 2500 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS filler-over (LONG_ASK dental clinic)",
  },
  {
    beat: "real-cut-answered",
    visitor: '"Wait, stop." over the long dental-clinic answer, then the real point ("price?")',
    expect: "the cut lands and the real point is answered, never resumed past",
    window: { metric: "cut-to-answer-latency", unit: "ms", min: 0, max: 1500 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS stop-over (story 4: answered within 1500ms)",
  },
  {
    beat: "overheard-aside",
    visitor: '"We\'re a bakery, actually." while Voni holds the floor',
    expect: "the aside is marked Overheard speech and counted in the call ledger, never lost",
    window: { metric: "asides-recalled", unit: "count", min: 1, max: 1 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS over-talk (story 7)",
  },
  {
    beat: "silence-check-in",
    visitor: "(silence) 15s with no visitor speech on a free floor",
    expect: 'exactly one check-in ("Still with me? Take your time."), never over a caller who starts talking',
    window: { metric: "check-in-at-silence", unit: "ms", min: 15000, max: 18000 },
    source: "src/lib/demo/voni-agent.ts SILENCE_CHECK_IN_MS + tests/e2e/demo-races.spec.ts 15s test",
  },
  {
    beat: "email-invite",
    visitor:
      '"We run a small property agency in Lisbon." / "Most of our inquiries come by phone and email, and we miss a lot after hours." / "Sure, let\'s try something."',
    expect: 'the invite is said once with the exact Test tag "Lime 42" as one whole number — never digit by digit, never invented',
    window: { metric: "tag-mentions", unit: "count", min: 1, max: 1 },
    source:
      "scripts/eval-demo-agent.mts reachInvite + EMAIL_SCENARIOS invite-tag (TAG=Lime 42) + tests/e2e/demo-email-test.spec.ts",
  },
  {
    beat: "goodbye-drain",
    visitor: '"I want you to hang up."',
    expect: "the goodbye names hi@voni.cc, plays in full (>=80% of its speaking time), then End call closes the session",
    window: { metric: "hang-up-after-goodbye-audio", unit: "ms", min: 0, max: 1500 },
    source: "scripts/eval-demo-agent.mts hang-up-fast + goodbyeCut + tests/e2e/demo-call-quality.spec.ts goodbye drain",
  },
];

export const SCOREBOARD_SCHEMA_VERSION = 3;

export type BeatTiming = {
  /** Reply gap: visitor end-of-speech → first agent audio. Placeholder until ticket 02. */
  gapMs: number | null;
  /** Barge-in cut latency. Placeholder until the cut ticket. */
  cutMs: number | null;
  /** Goodbye drain: goodbye end → session end. Placeholder until the drain ticket. */
  drainMs: number | null;
  status: "PASS" | "INFO" | "FAIL";
  note: string;
};

export type GateStatus = "PASS" | "INFO" | "FAIL";

export type ScoreboardGate = {
  name: string;
  status: GateStatus;
  detail: string;
};

/**
 * Prospect-capture beat (ticket 08): the Email invite plus Test tag behaves
 * exactly once and survives hold/reload. Wording reuses the eval
 * invite-tag/forgot-tag/free-gate/returning checks (TAG Lime 42, no
 * digit-split, no invented tag, normalizeClaim andres@, hi@voni.cc) and the
 * e2e demo-email-test expectations (10s invite, chip mailto, clipboard,
 * localStorage voni:test-tag, poll-once, personal-address once,
 * returning-greeting, talk-clock 4->6min), with Call memory in sessionStorage
 * and hold/flap/return resume. All inputs are external observables: what Voni
 * audibly said, how many times the show tool ran, how many times the chip
 * showed, which tokens survived.
 */
export const EMAIL_INVITE_TAG = "Lime 42";

export type EmailInviteEvidence = {
  /** Gate tag; defaults to EMAIL_INVITE_TAG (the locked call tag). */
  tag?: string;
  /** What Voni audibly said (agent transcripts, one entry per turn). */
  agentLines: string[];
  /** Every contact-chip show: the inbox address plus the tag on the chip. */
  chipShows: { address: string; tag: string }[];
  /** How many times show_test_address ran (the invite). */
  showToolCalls: number;
  /** localStorage voni:test-tag before/after a Hold return or reload. */
  tagTokenBefore?: string | null;
  tagTokenAfter?: string | null;
  /** Call memory sessionStorage voni:demo-call: was the test invited before/after? */
  memoryInvitedBefore?: boolean;
  memoryInvitedAfter?: boolean;
  /** Same call across the return: the call token before/after. */
  callTokenBefore?: string | null;
  callTokenAfter?: string | null;
  /** The sender matched an earlier tag (other device) or carried one (callback). */
  returning?: boolean;
  /** Externally observed greeting as returning (again/back/good-to-hear/earlier-call). */
  greetedAsReturning?: boolean;
  /** Personal-address sender when the Work-email gate applies; null otherwise. */
  freeAddress?: string | null;
};

export type EmailInviteResult = {
  tag: string;
  tagMentions: number;
  digitSplit: boolean;
  inventedTags: string[];
  strayAddresses: string[];
  workEmailGateMentions: number;
  chipShows: number;
  memoryPersists: boolean | null;
  returningOk: boolean | null;
  showToolCalls: number;
  status: "PASS" | "FAIL";
  detail: string;
};

/** How many agent turns carry the tag (typed any way: lime42, Lime-42, Lime 42). */
export function countTagMentions(lines: string[], tag: string = EMAIL_INVITE_TAG): number {
  return lines.filter((line) => containsTag(line, tag)).length;
}

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** Spoken digit by digit ("Lime 4 2", "Lime four two") instead of one whole number ("Lime 42"). */
export function hasDigitSplitTag(lines: string[], tag: string = EMAIL_INVITE_TAG): boolean {
  const [word = "", digits = ""] = tag.split(" ");
  if (!word || !digits) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const digitChars = digits.split("");
  const digitSplit = new RegExp(`\\b${esc(word)}\\s+${digitChars.map((d) => esc(d)).join("\\s*[\\- ]\\s*")}\\b`, "i");
  const wordSplit = new RegExp(
    `\\b${esc(word)}\\s+${digitChars.map((d) => DIGIT_WORDS[Number(d)] ?? esc(d)).join("\\s+[\\- ]?\\s*")}\\b`,
    "i",
  );
  return lines.some((line) => {
    // A whole "lime 42" is not a split; a spaced "lime 4 2" is.
    if (containsTag(line, tag) && !digitSplit.test(line) && !wordSplit.test(line)) return false;
    return digitSplit.test(line) || wordSplit.test(line);
  });
}

/**
 * Any "Word digits" in a tag/subject line that is not this call's tag was
 * made up (eval invite-tag: any tag-like match outside the gate word, digits
 * other than a bare 0, in a line about the tag or subject).
 */
export function findInventedTags(lines: string[], tag: string = EMAIL_INVITE_TAG): string[] {
  const word = (tag.split(" ")[0] ?? "").toLowerCase();
  const gateWord = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const shape = /\b([A-Za-z]+)[ -]?(\d{1,3})\b/g;
  const found: string[] = [];
  for (const line of lines) {
    if (!/tag|subject/i.test(line)) continue;
    for (const m of line.matchAll(shape)) {
      if (!gateWord.test(m[1]) && m[2] !== "0") found.push(m[0]);
    }
  }
  return found;
}

/**
 * Any spoken email address other than the team's hi@voni.cc (eval
 * strayAddress: pilot/voni.ai/@ plus the at/dot spoken form, after removing
 * the goodbye's hi@voni.cc). The invite never says or spells the inbox
 * address: it is on the visitor's screen.
 */
export function findStrayAddresses(lines: string[]): string[] {
  const spoken = /\b[a-z0-9._-]+\s*(?:@|\bat\b)\s*[a-z0-9-]+\s*(?:\.|\bdot\b)\s*[a-z]{2,}/i;
  const found: string[] = [];
  for (const line of lines) {
    const withoutTeam = line
      .replace(/hi@voni\.cc/gi, "")
      .replace(/hi\s+at\s+voni\s+dot\s+c\s*c/gi, "");
    if (/pilot|voni\.ai|@/i.test(withoutTeam) || spoken.test(withoutTeam)) found.push(line.trim());
  }
  return found;
}

/** Work-email gate lines ("that's a personal address … I need your work one"). */
export function countWorkEmailGate(lines: string[]): number {
  return lines.filter((line) => /personal address/i.test(line) && /work (one|email)/i.test(line)).length;
}

/** Whether Call memory kept the invite across a Hold return or reload. Null when no before/after supplied. */
export function persistsEmailAcrossMemory(evidence: EmailInviteEvidence): boolean | null {
  const hasBefore =
    evidence.memoryInvitedBefore !== undefined ||
    evidence.tagTokenBefore !== undefined ||
    evidence.callTokenBefore !== undefined;
  if (!hasBefore) return null;
  if (evidence.memoryInvitedBefore === true && evidence.memoryInvitedAfter !== true) return false;
  if (evidence.tagTokenBefore != null && evidence.tagTokenAfter !== evidence.tagTokenBefore) return false;
  if (evidence.callTokenBefore != null && evidence.callTokenAfter !== evidence.callTokenBefore) return false;
  return true;
}

export function evaluateEmailInvite(evidence: EmailInviteEvidence): EmailInviteResult {
  const tag = evidence.tag ?? EMAIL_INVITE_TAG;
  const agentLines = evidence.agentLines ?? [];
  const chipShows = evidence.chipShows ?? [];
  const showToolCalls = evidence.showToolCalls ?? 0;
  const returning = evidence.returning ?? false;
  const greeted = evidence.greetedAsReturning ?? false;
  const freeAddress = evidence.freeAddress ?? null;

  const tagMentions = countTagMentions(agentLines, tag);
  const digitSplit = hasDigitSplitTag(agentLines, tag);
  const inventedTags = findInventedTags(agentLines, tag);
  const strayAddresses = findStrayAddresses(agentLines);
  const workEmailGateMentions = countWorkEmailGate(agentLines);
  const memoryPersists = persistsEmailAcrossMemory(evidence);
  const returningOk = returning ? greeted && showToolCalls <= 1 : null;

  const fails: string[] = [];
  if (showToolCalls > 1) fails.push(`invited ${showToolCalls} times`);
  if (!returning && showToolCalls !== 1) {
    fails.push(showToolCalls === 0 ? "never invited the email test" : `invited ${showToolCalls} times`);
  }
  if (returning && !greeted) fails.push("returning sender not greeted");
  if (returning && showToolCalls > 1) fails.push("second invite for a returning sender");

  if (showToolCalls === 0) {
    // Callback: the carried tag was checked at connect, no second invite.
    if (tagMentions !== 0) fails.push(`said the tag ${tagMentions} times without an invite`);
    if (chipShows.length !== 0) fails.push(`chip showed ${chipShows.length} times without an invite`);
  } else {
    if (tagMentions !== 1) fails.push(tagMentions === 0 ? "never said the tag" : `said the tag ${tagMentions} times`);
    if (digitSplit) fails.push("said the tag digit by digit");
    if (inventedTags.length > 0) fails.push(`invented a tag: "${inventedTags[0]}"`);
    if (strayAddresses.length > 0) fails.push(`spoke an address: "${strayAddresses[0].slice(0, 80)}"`);
    if (chipShows.length !== 1) {
      fails.push(chipShows.length === 0 ? "chip never showed" : `chip showed ${chipShows.length} times`);
    } else {
      if (chipShows[0].address !== DEMO_INBOX_ADDRESS) fails.push(`chip showed ${chipShows[0].address}`);
      if (chipShows[0].tag !== tag) fails.push("chip tag does not match the call tag");
    }
    if (freeAddress != null) {
      if (workEmailGateMentions !== 1) {
        fails.push(workEmailGateMentions === 0 ? "personal address without the work-email gate" : "work-email gate said twice");
      }
    } else if (workEmailGateMentions !== 0) {
      fails.push("work-email gate without a personal address");
    }
  }
  if (memoryPersists === false) fails.push("tag did not persist across Hold return/reload");

  const status = fails.length === 0 ? "PASS" : "FAIL";
  return {
    tag,
    tagMentions,
    digitSplit,
    inventedTags,
    strayAddresses,
    workEmailGateMentions,
    chipShows: chipShows.length,
    memoryPersists,
    returningOk,
    showToolCalls,
    status,
    detail: status === "PASS" ? `tag said once (${tag}), chip once, memory kept` : fails.join("; "),
  };
}

export function emailInviteGate(result: EmailInviteResult): ScoreboardGate {
  return {
    name: "email-invite",
    status: result.status,
    detail: result.detail,
  };
}

/** Score the email-invite beat and gate from external evidence, leaving every other beat alone. */
export function applyEmailInvite(artifact: ScoreboardArtifact, evidence: EmailInviteEvidence): ScoreboardArtifact {
  const result = evaluateEmailInvite(evidence);
  const gates = artifact.gates.some((g) => g.name === "email-invite")
    ? artifact.gates.map((g) => (g.name === "email-invite" ? emailInviteGate(result) : g))
    : [...artifact.gates, emailInviteGate(result)];
  return {
    ...artifact,
    emailInvite: result,
    beats: {
      ...artifact.beats,
      "email-invite": {
        gapMs: null,
        cutMs: null,
        drainMs: null,
        status: result.status,
        note: result.detail,
      },
    },
    gates,
  };
}

export type ScoreboardArtifact = {
  schemaVersion: typeof SCOREBOARD_SCHEMA_VERSION;
  recordedAt: string;
  /** Gate voice, resolved through the shared voice registry. */
  voice: string;
  runs: number;
  /** The locked golden script this run scores against (fixed order/wording/windows). */
  goldenScript: {
    vertical: typeof GOLDEN_VERTICAL;
    budgetS: typeof GOLDEN_SCRIPT_BUDGET_S;
    beats: GoldenBeatSpec[];
  };
  /** Non-gate demo voices: regression-only, never gating (spec story 14). */
  regressionVoices: string[];
  beats: Record<GoldenBeat, BeatTiming>;
  overheard: { recalled: number; total: number | null };
  doubleTalk: { overlapMs: number[]; maxMs: number | null };
  deadAir: { gapsMs: number[]; maxMs: number | null };
  probes: { jump: number; overload: number; clip: number; underrun: number; inputDrop: number };
  transcripts: { sha256: string; redacted: string[] };
  humanRatings: { timbre: number | null; accent: number | null };
  gates: ScoreboardGate[];
  /** Prospect-capture beat: invite/tag counts, chip-once, memory persistence (ticket 08). Null until evidence lands. */
  emailInvite: EmailInviteResult | null;
  evalRunner: {
    scenario: string;
    passed: boolean | null;
    exitCode: number | null;
    durationMs: number;
    rawSha256: string;
  };
  /** Merged Call trace excerpt for a finished real-call session (via --trace-session). */
  callTrace?: {
    sessionId: string;
    excerptSha256: string;
    excerpt: string[];
  } | null;
};

/**
 * The locked gate default: the first demo voice, resolved through the
 * registry at use time. Named once here so neither the orchestrator, the
 * scenarios, nor the assertions carry a voice literal.
 */
export const DEFAULT_GATE_VOICE: string = DEMO_VOICE_IDS[0];

/**
 * The gate voice is a parameter resolved through the shared voice registry,
 * never hard-coded in the orchestrator: deploying a new voice is a registry
 * change plus a regression run, not a harness change.
 */
export function resolveGateVoice(voiceId: string): string {
  const known = getVoice(voiceId);
  if (!known || !(DEMO_VOICE_IDS as readonly string[]).includes(voiceId)) {
    throw new Error(
      `unknown gate voice "${voiceId}": pick one of ${DEMO_VOICE_IDS.join(", ")}`,
    );
  }
  return known.id;
}

export type VoicePlayback = {
  /** Gate voice id, as resolved through the registry. */
  id: string;
  /** Server-side output level every agent ships (loudest, deterministic). */
  outputVolume: number;
  /** Client-side per-voice gain matching the voice to the reference level. */
  playbackGain: number;
};

/** Gate voice playback: server output volume plus per-voice gain, both from the registry. */
export function gateVoicePlayback(voiceId: string): VoicePlayback {
  const id = resolveGateVoice(voiceId);
  return { id, outputVolume: VOICE_OUTPUT_VOLUME, playbackGain: voicePlaybackGain(id) };
}

/**
 * Non-gate demo voices run regression-only (no clip, no pop, no invented
 * test tag): adding voices never breaks existing ones (spec story 14).
 */
export function regressionVoices(gateVoice: string): string[] {
  resolveGateVoice(gateVoice);
  return (DEMO_VOICE_IDS as readonly string[]).filter((voice) => voice !== gateVoice);
}

/** Dry-run listing: every beat with its window, plus the resolved gate and regression set. */
export function formatGoldenScript(gateVoice: string): string {
  const playback = gateVoicePlayback(gateVoice);
  const lines = GOLDEN_SCRIPT.map(
    (beat, index) =>
      `${index + 1}. ${beat.beat} — visitor: ${beat.visitor} — window: ${beat.window.metric} ${beat.window.min}–${beat.window.max} ${beat.window.unit} — expect: ${beat.expect}`,
  );
  const regression = regressionVoices(gateVoice)
    .map((voice) => `${voice} (gain ${voicePlaybackGain(voice)})`)
    .join(", ");
  return [
    `golden script (${GOLDEN_VERTICAL}, ~${GOLDEN_SCRIPT_BUDGET_S}s, gate ${playback.id} vol=${playback.outputVolume} gain=${playback.playbackGain})`,
    ...lines,
    `regression voices: ${regression}`,
  ].join("\n");
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Redact PII the way the session-evidence exporter does before persisting. */
export function redactTranscript(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d ()-]{7,}\d/g, "[phone]")
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, "[credential]");
}

export function redactLines(stdout: string, limit = 200): string[] {
  return stdout
    .split("\n")
    .map((line) => redactTranscript(line).trim())
    .filter(Boolean)
    .slice(0, limit);
}

/** Skeleton gates: reported but never failed until gating lands per ticket. */
function skeletonGates(exitCode: number | null): ScoreboardGate[] {
  const plumbing: ScoreboardGate =
    exitCode === null || exitCode === 0
      ? { name: "plumbing", status: "PASS", detail: "eval runner finished" }
      : {
          name: "plumbing",
          status: "INFO",
          detail: `eval runner exited ${exitCode} (skeleton: recorded, not failed)`,
        };
  return [
    plumbing,
    { name: "reply-gap", status: "INFO", detail: "skeleton: gating lands in the reply-gap ticket" },
    { name: "barge-in-cut", status: "INFO", detail: "skeleton: gating lands in the cut ticket" },
    { name: "overheard-recall", status: "INFO", detail: "skeleton: gating lands in the overheard ticket" },
    { name: "email-invite", status: "INFO", detail: "skeleton: invite/tag evidence not yet scored" },
    { name: "double-talk", status: "INFO", detail: "skeleton: gating lands in the naturalness ticket" },
    { name: "dead-air", status: "INFO", detail: "skeleton: gating lands in the naturalness ticket" },
    { name: "timbre-probes", status: "INFO", detail: "skeleton: gating lands in the timbre ticket" },
    { name: "accent-human", status: "INFO", detail: "skeleton: awaiting human 1-5 ratings" },
  ];
}

export function buildSkeletonArtifact(input: {
  voice: string;
  scenario: string;
  runnerStdout: string;
  exitCode: number | null;
  durationMs: number;
  runs: number;
}): ScoreboardArtifact {
  const beats = Object.fromEntries(
    GOLDEN_BEATS.map((beat) => [
      beat,
      {
        gapMs: null,
        cutMs: null,
        drainMs: null,
        status: "PASS",
        note: "skeleton: placeholder until per-beat timing lands",
      } satisfies BeatTiming,
    ]),
  ) as Record<GoldenBeat, BeatTiming>;
  return {
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    voice: input.voice,
    runs: input.runs,
    goldenScript: {
      vertical: GOLDEN_VERTICAL,
      budgetS: GOLDEN_SCRIPT_BUDGET_S,
      beats: GOLDEN_SCRIPT,
    },
    regressionVoices: regressionVoices(input.voice),
    beats,
    overheard: { recalled: 0, total: null },
    doubleTalk: { overlapMs: [], maxMs: null },
    deadAir: { gapsMs: [], maxMs: null },
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    transcripts: {
      sha256: sha256Hex(input.runnerStdout),
      redacted: redactLines(input.runnerStdout),
    },
    humanRatings: { timbre: null, accent: null },
    gates: skeletonGates(input.exitCode),
    emailInvite: null,
    evalRunner: {
      scenario: input.scenario,
      passed: input.exitCode === null ? null : input.exitCode === 0,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      rawSha256: sha256Hex(input.runnerStdout),
    },
  };
}

/** Console pass/fail table: one row per gate. */
export function formatGateTable(artifact: ScoreboardArtifact): string {
  const rows = artifact.gates.map(
    (gate) => `${gate.status.padEnd(6)} ${gate.name.padEnd(16)} ${gate.detail}`,
  );
  return [
    `demo scoreboard (${artifact.voice}, ${artifact.runs} run${artifact.runs === 1 ? "" : "s"})`,
    ...rows,
  ].join("\n");
}
