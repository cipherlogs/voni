/**
 * The subject axis (voice-parity ticket 72, spec W5).
 *
 * A subject is `{agent, Locale, transport}`. The featured voice is one subject,
 * not the owner of the axis: a run can name a different voice, a tenant agent or
 * the phone transport, the artifact carries that subject, and the gates come
 * from that run's own evidence. These tests never listen to audio: they assert
 * the harness's external contract — what a run says it measured, what it
 * refuses to accept, and where a verdict comes from.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_VOICE_IDS } from "./voni-agent";
import { CONVERSATION_LANGUAGES } from "@/lib/agents/wizard";
import { getVoice } from "@/lib/agents/voices";
import { UNMEASURED_VOICE_LEVELS } from "@/lib/agents/voice-levels";
import {
  LOCALE_SUBJECT_STATUSES,
  SubjectError,
  UNBOUND_VOICES,
  UnknownVoiceError,
  UnboundVoiceError,
  bindCascadeVoice,
  cascadeSubjectList,
  defaultSubject,
  formatSubject,
  isCascadeSubjectVoice,
  localeSubjectStatus,
  resolveCascadeSubject,
  resolveSubject,
  sameSubject,
  subjectOrLegacy,
  type SubjectRecord,
} from "./subject";
import {
  DEFAULT_GATE_VOICE,
  REPLY_GAP_P95_BUDGET_MS,
  buildSkeletonArtifact,
  subjectOfArtifact,
  type ScoreboardArtifact,
} from "./scoreboard";
import { subjectGateVerdict } from "./subject-verdict";
import { buildInspectReport, formatInspectReport } from "./scoreboard-report";
import { parseServedDemoAgentBody } from "./stored-agents";
import { evalRunnerArgv, parseEvalAgentId } from "./eval-transport";

const SCRIPT = new URL("../../../scripts/score-demo.mts", import.meta.url).pathname;

/** The run evidence a scenario produces: one merged greeting-cut gap. */
function artifactFor(
  subject: SubjectRecord,
  voice: string,
  gapMs: number,
): ScoreboardArtifact {
  return buildSkeletonArtifact({
    voice,
    subject,
    scenario: "greeting-cut",
    // A finished runner with one measured gap: plumbing is PASS and the
    // reply-gap gate judges this run's own number, not another run's.
    runnerStdout:
      'EVAL SUMMARY {"scenario":"greeting-cut","runs":1,"failures":0,' +
      '"scenarios":[{"name":"greeting-cut","passed":1,"runs":1}],' +
      '"traceSessions":["sess_subject"],"playout":[],"audioChunks":12,"live":true}\n',
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    codeFingerprint: { head: "a".repeat(40), dirty: false, dirtyHash: "0".repeat(64) },
    gaps: { "greeting-cut": [gapMs] },
  });
}

test("a withdrawn demo voice is refused by name, never measured as a subject", () => {
  for (const voice of ["malvina", "donatien", "jorg", "benicio"]) {
    assert.throws(
      () => resolveSubject({ voice, explicit: true }),
      (error: unknown) =>
        error instanceof SubjectError &&
        error.field === "agent" &&
        new RegExp(`unknown gate voice "${voice}"`).test(error.message),
      `${voice} is no longer offered: English only`,
    );
  }
  const subject = resolveSubject({ voice: "audrey", explicit: true });
  assert.deepEqual(subject, {
    agent: { kind: "demo", voice: "audrey", agentId: null },
    locale: "en",
    transport: "browser",
    source: "flag",
  });
  assert.equal(
    formatSubject(subject),
    "demo audrey (en, browser)",
    "the subject prints as agent, Locale and transport",
  );
});

test("the featured voice is one subject, not the owner of the axis", () => {
  const featured = defaultSubject();
  assert.deepEqual(featured, {
    agent: { kind: "demo", voice: DEFAULT_GATE_VOICE, agentId: null },
    locale: "en",
    transport: "browser",
    source: "default",
  });
  // Every other demo voice is the same kind of subject, with no special case.
  for (const voice of DEMO_VOICE_IDS) {
    const subject = resolveSubject({ voice, explicit: true });
    assert.equal(subject.agent.kind, "demo");
    assert.equal(subject.agent.voice, voice);
  }
});

test("a prior diff is scoped to the subject, never to a shared voice id", () => {
  const featured = defaultSubject();
  const legacy = subjectOrLegacy({ voice: DEFAULT_GATE_VOICE });
  assert.ok(sameSubject(featured, legacy), "provenance is not part of the identity");
  const tenant = resolveSubject({
    agent: "agent_tenant_42",
    voice: DEFAULT_GATE_VOICE,
    locale: "en",
    explicit: true,
  });
  assert.ok(
    !sameSubject(tenant, featured),
    "a tenant agent and a demo voice with the same id are different subjects",
  );
  assert.ok(
    !sameSubject(
      resolveSubject({ agent: "agent_other", voice: "audrey", locale: "en", explicit: true }),
      featured,
    ),
    "another agent is another subject",
  );
  assert.ok(
    !sameSubject(
      resolveSubject({ agent: "agent_a", voice: "malvina", locale: "es", explicit: true }),
      resolveSubject({ agent: "agent_b", voice: "malvina", locale: "es", explicit: true }),
    ),
    "another tenant agent is another subject",
  );
});

test("a tenant agent is a subject, measurable through the same harness", () => {
  const subject = resolveSubject({
    agent: "agent_tenant_42",
    voice: "malvina",
    locale: "es",
    transport: "phone",
    explicit: true,
  });
  assert.deepEqual(subject, {
    agent: { kind: "tenant", agentId: "agent_tenant_42" },
    locale: "es",
    transport: "phone",
    source: "flag",
  });
  assert.equal(formatSubject(subject), "tenant agent_tenant_42 (es, phone)");
});

test("a tenant subject is measurable through the same runner", () => {
  assert.equal(parseEvalAgentId(["--voice", "malvina"]), null);
  assert.equal(parseEvalAgentId(["--agent", "agent_tenant_42"]), "agent_tenant_42");
  assert.throws(() => parseEvalAgentId(["--agent", ""]), /needs a tenant agent id/);
  assert.deepEqual(
    evalRunnerArgv({
      voice: "malvina",
      scenario: "greeting-cut",
      runs: "1",
      agentId: "agent_tenant_42",
    }),
    [
      "run",
      "eval:demo-agent",
      "--",
      "--voice",
      "malvina",
      "--scenario",
      "greeting-cut",
      "--runs",
      "1",
      "--agent",
      "agent_tenant_42",
    ],
    "the tenant agent rides the same runner invocation, not a second harness",
  );
});

test("an unknown voice, agent or Locale fails by name", () => {
  assert.throws(
    () => resolveSubject({ voice: "not-a-voice" }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "agent" &&
      /unknown gate voice "not-a-voice"/.test(error.message),
    "an unknown demo voice is named",
  );
  assert.throws(
    () => resolveSubject({ agent: "   ", locale: "es" }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "agent" &&
      /needs an agent id/.test(error.message),
    "an empty tenant agent is named, never measured as the default",
  );
  assert.throws(
    () => resolveSubject({ agent: DEMO_VOICE_IDS[0], locale: "en" }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "agent" &&
      /names a demo voice/.test(error.message),
    "a demo voice cannot be smuggled in as a tenant agent",
  );
  assert.throws(
    () => resolveSubject({ voice: "audrey", locale: "xx" }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "locale" &&
      /unknown Locale "xx"/.test(error.message),
    "an unknown Locale is named",
  );
  assert.throws(
    () => resolveSubject({ agent: "agent_tenant_42", locale: "" }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "locale" &&
      /tenant subject needs a Locale/.test(error.message),
    "a tenant subject with no Locale cannot silently borrow English",
  );
  assert.throws(
    () => resolveSubject({ voice: "audrey", transport: "wire" }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "transport" &&
      /unknown transport "wire"/.test(error.message),
    "an unknown transport is named",
  );
});

test("a voice speaks exactly one Locale: a mismatched Locale fails naming both", () => {
  assert.equal(resolveSubject({ voice: "audrey", locale: "en" }).locale, "en");
  assert.throws(
    () => resolveSubject({ voice: "audrey", locale: "fr" }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "locale" &&
      /voice "audrey" speaks en/.test(error.message) &&
      /not "fr"/.test(error.message),
    "the refusal names the voice's Locale and the requested one",
  );
  // A tenant agent's voice binding is checked too: a Locale the bound voice
  // does not speak would measure a call the agent cannot conduct.
  assert.throws(
    () => resolveSubject({ agent: "agent_tenant_42", voice: "malvina", locale: "fr" }),
    /voice "malvina" speaks es/,
  );
});

test("an artifact carries the subject it measured and derives its own gates", () => {
  const audrey = resolveSubject({ voice: "audrey", explicit: true });
  const fasta = artifactFor(audrey, "audrey", 900);
  const late = artifactFor(audrey, "audrey", REPLY_GAP_P95_BUDGET_MS + 5000);

  assert.deepEqual(fasta.subject, audrey, "the artifact carries the measured subject");
  assert.equal(fasta.voice, "audrey");
  assert.equal(late.subject?.locale, "en");

  const pass = fasta.gates.find((gate) => gate.name === "reply-gap")!;
  const fail = late.gates.find((gate) => gate.name === "reply-gap")!;
  assert.equal(pass.status, "PASS", pass.detail);
  assert.equal(fail.status, "FAIL", fail.detail);
  // The failing detail cites this run's own number, and the artifact names the
  // voice it belongs to: a verdict cannot be read without its subject.
  assert.match(fail.detail, /7500ms/);
  assert.equal(fasta.subject?.agent.kind === "demo" && fasta.subject.agent.voice, "audrey");
});

test("a tenant artifact carries the agent and the phone transport", () => {
  const tenant = resolveSubject({
    agent: "agent_tenant_42",
    voice: "malvina",
    locale: "es",
    transport: "phone",
    explicit: true,
  });
  const artifact = artifactFor(tenant, "malvina", 900);
  assert.deepEqual(artifact.subject?.agent, { kind: "tenant", agentId: "agent_tenant_42" });
  assert.equal(artifact.subject?.transport, "phone");
  assert.equal(artifact.subject?.locale, "es");
  assert.deepEqual(
    artifact.regressionVoices,
    [],
    "a tenant subject is not a demo regression row",
  );
});

test("a subject verdict comes from its own artifact, never another subject's", () => {
  const featured = defaultSubject();
  const tenant = resolveSubject({
    agent: "agent_tenant_42",
    voice: "malvina",
    locale: "es",
    explicit: true,
  });
  const featuredArtifact = artifactFor(featured, DEFAULT_GATE_VOICE, 900);
  const tenantArtifact = artifactFor(tenant, "malvina", REPLY_GAP_P95_BUDGET_MS + 5000);

  const featuredVerdict = subjectGateVerdict(featuredArtifact);
  const tenantVerdict = subjectGateVerdict(tenantArtifact);
  assert.equal(featuredVerdict.status, "PASS");
  assert.equal(tenantVerdict.status, "FAIL");
  assert.deepEqual(tenantVerdict.subject, tenant);
  assert.equal(tenantVerdict.runId, tenantArtifact.runId);
  assert.match(tenantVerdict.detail, /tenant agent_tenant_42 \(es, browser\)/);
  // The verdict is a function of one artifact: there is no parameter through
  // which the featured voice's verdict could be carried in.
  assert.equal(subjectGateVerdict.length, 1);
});

test("a tenant subject's evidence cannot come from another agent's served body", () => {
  const tenant = resolveSubject({
    agent: "agent_tenant_42",
    voice: "malvina",
    locale: "es",
    explicit: true,
  });
  const bodyOf = (agentId: string) => {
    const parsed = parseServedDemoAgentBody(agentId, {
      input: { turn_detection: null },
      output: { volume: 0 },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return { measured: true as const, body: parsed.body, agentId, fingerprint: null };
  };
  const artifact = buildSkeletonArtifact({
    voice: "malvina",
    subject: tenant,
    scenario: "greeting-cut",
    runnerStdout: "EVAL SUMMARY {}\n",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
    runBody: bodyOf("agent_other"),
  });
  assert.equal(artifact.agentBody?.measured, false);
  assert.match(artifact.agentBody?.reason ?? "", /agent_other/);
  assert.match(artifact.agentBody?.reason ?? "", /agent_tenant_42/);
});

test("an artifact refuses a subject whose voice it did not measure", () => {
  const audrey = resolveSubject({ voice: "audrey", explicit: true });
  assert.throws(
    () => artifactFor(audrey, "lola", 900),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "agent" &&
      /not the demo subject's voice "audrey"/.test(error.message),
  );
});

test("the compact report records the subject", () => {
  const tenant = resolveSubject({
    agent: "agent_tenant_42",
    voice: "malvina",
    locale: "es",
    transport: "phone",
    explicit: true,
  });
  const artifact = artifactFor(tenant, "malvina", 900);
  const report = buildInspectReport(artifact);
  assert.deepEqual(report.run.subject, tenant);
  assert.match(
    formatInspectReport(report),
    /subject\s+tenant agent_tenant_42 \(es, phone\)/,
    "the compact report prints the subject",
  );
});

test("a pre-axis artifact derives its subject from the voice it measured", () => {
  const artifact = artifactFor(defaultSubject(), DEFAULT_GATE_VOICE, 900);
  const legacy = { ...artifact } as Partial<ScoreboardArtifact>;
  delete legacy.subject;
  const derived = subjectOrLegacy({ subject: undefined, voice: DEFAULT_GATE_VOICE });
  assert.equal(derived.source, "legacy");
  assert.deepEqual(derived.agent, {
    kind: "demo",
    voice: DEFAULT_GATE_VOICE,
    agentId: null,
  });
  assert.equal(derived.locale, "en");
  assert.equal(derived.transport, "browser");
  assert.deepEqual(subjectOfArtifact(legacy as ScoreboardArtifact), derived);
});

test("score-demo records the explicit demo subject in the artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "subject-"));
  const out = join(dir, "score.json");
  const result = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      SCRIPT,
      "--dry-run",
      "--voice",
      "audrey",
      "--subject-locale",
      "en",
      "--subject-transport",
      "phone",
      "--out",
      out,
    ],
    { encoding: "utf8", cwd: new URL("../../../", import.meta.url).pathname },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as ScoreboardArtifact;
  assert.deepEqual(artifact.subject, {
    agent: { kind: "demo", voice: "audrey", agentId: null },
    locale: "en",
    transport: "phone",
    source: "flag",
  });
});

test("score-demo refuses a withdrawn voice before writing an artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "subject-"));
  const out = join(dir, "score.json");
  const result = spawnSync(
    "node",
    ["--import", "tsx", SCRIPT, "--dry-run", "--voice", "malvina", "--out", out],
    { encoding: "utf8", cwd: new URL("../../../", import.meta.url).pathname },
  );
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out), "no artifact for a withdrawn voice");
  assert.match(result.stderr + result.stdout, /unknown gate voice "malvina"/);
});

test("score-demo runs a tenant subject through the same command", () => {
  const dir = mkdtempSync(join(tmpdir(), "subject-"));
  const out = join(dir, "score.json");
  const result = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      SCRIPT,
      "--dry-run",
      "--agent",
      "agent_tenant_42",
      "--voice",
      "malvina",
      "--subject-locale",
      "es",
      "--subject-transport",
      "phone",
      "--out",
      out,
    ],
    { encoding: "utf8", cwd: new URL("../../../", import.meta.url).pathname },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as ScoreboardArtifact;
  assert.deepEqual(artifact.subject?.agent, { kind: "tenant", agentId: "agent_tenant_42" });
  assert.equal(artifact.subject?.transport, "phone");
  assert.deepEqual(artifact.regressionVoices, []);
});

test("score-demo refuses to diff one subject against another's artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "subject-"));
  const first = join(dir, "anna.json");
  const cwd = new URL("../../../", import.meta.url).pathname;
  const firstRun = spawnSync(
    "node",
    ["--import", "tsx", SCRIPT, "--dry-run", "--out", first],
    { encoding: "utf8", cwd },
  );
  assert.equal(firstRun.status, 0, firstRun.stderr + firstRun.stdout);
  const out = join(dir, "tenant.json");
  const crossed = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      SCRIPT,
      "--dry-run",
      "--agent",
      "agent_other",
      "--voice",
      "audrey",
      "--subject-locale",
      "en",
      "--out",
      out,
      "--prior",
      first,
    ],
    { encoding: "utf8", cwd },
  );
  assert.notEqual(crossed.status, 0);
  assert.match(
    crossed.stderr + crossed.stdout,
    /a diff only compares the same subject/,
    "a prior from another subject is refused by name",
  );
  assert.ok(!existsSync(out), "no artifact is written for a cross-subject diff");
});

test("score-demo fails by name before writing an artifact for a bad subject", () => {
  const dir = mkdtempSync(join(tmpdir(), "subject-"));
  const out = join(dir, "score.json");
  const badLocale = spawnSync(
    "node",
    ["--import", "tsx", SCRIPT, "--dry-run", "--voice", "audrey", "--subject-locale", "xx", "--out", out],
    { encoding: "utf8", cwd: new URL("../../../", import.meta.url).pathname },
  );
  assert.notEqual(badLocale.status, 0);
  assert.ok(!existsSync(out), "no artifact for an unknown Locale");
  assert.match(badLocale.stderr + badLocale.stdout, /unknown Locale "xx"/);

  const badAgent = spawnSync(
    "node",
    ["--import", "tsx", SCRIPT, "--dry-run", "--agent", "", "--subject-locale", "es", "--out", out],
    { encoding: "utf8", cwd: new URL("../../../", import.meta.url).pathname },
  );
  assert.notEqual(badAgent.status, 0);
  assert.ok(!existsSync(out), "no artifact for a missing tenant agent");
  assert.match(badAgent.stderr + badAgent.stdout, /needs an agent id/);
});

// ── No voice without a binding (ticket 131, W1) ─────────────────────────────

test("the historical German id cannot be bound, and the product voice can", () => {
  assert.equal(isCascadeSubjectVoice("malvina"), true);
  assert.equal(isCascadeSubjectVoice("jorg"), true, "German is bound to the chosen voice");
  assert.equal(isCascadeSubjectVoice("juergen"), false, "the old id is not a cascade subject");
  assert.equal(isCascadeSubjectVoice("not-a-voice"), false);

  assert.throws(
    () => bindCascadeVoice("juergen"),
    (error: unknown) =>
      error instanceof UnboundVoiceError &&
      error.voiceId === "juergen" &&
      error.locale === "de" &&
      /voice_not_found/.test(error.message) &&
      /replaced by jorg/.test(error.message),
    "the refusal names the voice, its Locale and why it is unbound",
  );
  assert.throws(
    () => bindCascadeVoice("not-a-voice"),
    (error: unknown) =>
      error instanceof UnknownVoiceError &&
      error.voiceId === "not-a-voice" &&
      /not in the voice binding table/.test(error.message),
  );
  assert.deepEqual(bindCascadeVoice("jorg"), {
    voiceId: "jorg",
    locale: "de",
    language: "German",
  });

  assert.throws(
    () => resolveCascadeSubject({ voice: "juergen", explicit: true }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "agent" &&
      /unknown gate voice "juergen"/.test(error.message),
    "the old id is not a demo subject; a run cannot measure it",
  );
});

test("a withdrawn Locale stays open while its voice binding is preserved", () => {
  const german = localeSubjectStatus("de");
  assert.equal(german.locale, "de");
  assert.equal(german.status, "open", "no demo voice is offered for German: English only");
  assert.deepEqual(german.voices, []);
  assert.match(german.openReason ?? "", /no demo voice/);

  assert.deepEqual(
    LOCALE_SUBJECT_STATUSES,
    ["bound", "open"],
    "the vocabulary has no beta, dropped or cut-over state to hide behind",
  );

  // The voice binding is preserved: English-only is a roster choice, not a
  // language switch inside a voice. German stays bound to the catalogue voice.
  assert.deepEqual(bindCascadeVoice("jorg"), {
    voiceId: "jorg",
    locale: "de",
    language: "German",
  });

  // The historical id is a routing fact, not a mutation: naming it is refused
  // and the list never quietly changes.
  const before = cascadeSubjectList();
  assert.throws(() => resolveCascadeSubject({ voice: "juergen" }), SubjectError);
  assert.deepEqual(cascadeSubjectList(), before, "a refused voice never quietly changes a row");

  // The historical id is no longer a catalogue voice, so it cannot be offered
  // as a managed subject either.
  assert.equal(getVoice("juergen"), undefined);
  assert.equal(getVoice("jorg")?.languageCode, "de");
});

test("the subject list names each Locale's status explicitly", () => {
  const rows = cascadeSubjectList();

  assert.deepEqual(
    rows.map((row) => row.locale),
    [...CONVERSATION_LANGUAGES],
    "one row per offered Locale, in the product's order",
  );
  for (const row of rows) {
    assert.ok(
      row.status === "bound" || row.status === "open",
      `${row.locale} names its status explicitly, not by omission`,
    );
    assert.equal(row.status === "open", row.voices.length === 0, `${row.locale} is consistent`);
  }

  const bound = Object.fromEntries(rows.filter((row) => row.status === "bound").map((row) => [row.locale, row.voices]));
  assert.deepEqual(bound, {
    en: ["audrey"],
  });
  for (const locale of ["es", "fr", "de", "pt"]) {
    const row = rows.find((row) => row.locale === locale);
    assert.ok(row, `${locale} is listed, not omitted`);
    assert.equal(row.status, "open", `the demo offers English only and ${locale} is not one`);
    assert.deepEqual(row.voices, []);
    assert.match(row.openReason ?? "", /no demo voice/);
  }
  const italian = rows.find((row) => row.locale === "it");
  assert.ok(italian, "Italian is listed, not omitted");
  assert.equal(italian.status, "open", "the demo offers English only and Italian is not one");
  assert.deepEqual(italian.voices, []);
  assert.match(italian.openReason ?? "", /no demo voice/);
  assert.equal(localeSubjectStatus("en").status, "bound", "English is bound to audrey, and says so");
});

test("the unbound table names historical ids, and the unmeasured gaps are named", () => {
  for (const [voiceId, unbound] of Object.entries(UNBOUND_VOICES)) {
    assert.equal(unbound.historical, true, `${voiceId} is a historical row, not an offered voice`);
    assert.equal(getVoice(voiceId), undefined, `${voiceId} is no longer in the catalogue`);
    assert.equal(unbound.locale, "de", `${voiceId} keeps its Locale recorded`);
    assert.match(unbound.reason, /422 voice_not_found/);
  }
  assert.deepEqual(
    UNMEASURED_VOICE_LEVELS.map((row) => row.voice).sort(),
    ["audrey", "benicio", "donatien", "malvina"],
    "the demo voices added after the measured run are named gaps, not silent 100s",
  );
});

test("a cascade subject carries its pipeline axis, so the A/B cannot merge", () => {
  const cascade = resolveCascadeSubject({ voice: "audrey", explicit: true });
  assert.equal(cascade.pipeline, "cascade");
  assert.equal(formatSubject(cascade), "demo audrey (en, browser, cascade)");

  const managed = resolveSubject({ voice: "audrey", explicit: true });
  assert.equal(managed.pipeline, undefined, "a managed subject written before the axis stays managed");
  assert.equal(formatSubject(managed), "demo audrey (en, browser)");

  assert.ok(!sameSubject(cascade, managed), "the same voice on two engines is two subjects");
  assert.ok(
    sameSubject(cascade, resolveCascadeSubject({ voice: "audrey", explicit: true })),
    "two cascade runs of one voice are one subject",
  );
});

test("the TS binding table and the Python binding table name the same unbound voice", () => {
  const python = readFileSync(
    new URL("../../../../voice-pipeline/cascade/voice_binding.py", import.meta.url),
    "utf8",
  );
  const unbound = python.slice(python.indexOf("UNBOUND_VOICES"));
  for (const voiceId of Object.keys(UNBOUND_VOICES)) {
    assert.match(
      unbound,
      new RegExp(`"${voiceId}"`),
      `${voiceId} is unbound in the Python table too, or the two engines disagree about its Locale`,
    );
  }
});
