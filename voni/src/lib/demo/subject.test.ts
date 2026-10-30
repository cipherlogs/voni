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

test("a non-default demo voice is a subject with its own Locale and transport", () => {
  const subject = resolveSubject({ voice: "lola", explicit: true });
  assert.deepEqual(subject, {
    agent: { kind: "demo", voice: "lola", agentId: null },
    locale: "es",
    transport: "browser",
    source: "flag",
  });
  assert.equal(
    formatSubject(subject),
    "demo lola (es, browser)",
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
    !sameSubject(resolveSubject({ voice: "lola", explicit: true }), featured),
    "another voice is another subject",
  );
  assert.ok(
    !sameSubject(
      resolveSubject({ agent: "agent_a", voice: "lola", locale: "es", explicit: true }),
      resolveSubject({ agent: "agent_b", voice: "lola", locale: "es", explicit: true }),
    ),
    "another tenant agent is another subject",
  );
});

test("a tenant agent is a subject, measurable through the same harness", () => {
  const subject = resolveSubject({
    agent: "agent_tenant_42",
    voice: "lola",
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
  assert.equal(parseEvalAgentId(["--voice", "lola"]), null);
  assert.equal(parseEvalAgentId(["--agent", "agent_tenant_42"]), "agent_tenant_42");
  assert.throws(() => parseEvalAgentId(["--agent", ""]), /needs a tenant agent id/);
  assert.deepEqual(
    evalRunnerArgv({
      voice: "lola",
      scenario: "greeting-cut",
      runs: "1",
      agentId: "agent_tenant_42",
    }),
    [
      "run",
      "eval:demo-agent",
      "--",
      "--voice",
      "lola",
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
    () => resolveSubject({ voice: "lola", locale: "xx" }),
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
    () => resolveSubject({ voice: "lola", transport: "wire" }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "transport" &&
      /unknown transport "wire"/.test(error.message),
    "an unknown transport is named",
  );
});

test("a voice speaks exactly one Locale: a mismatched Locale fails naming both", () => {
  assert.equal(resolveSubject({ voice: "lola", locale: "es" }).locale, "es");
  assert.throws(
    () => resolveSubject({ voice: "lola", locale: "en" }),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "locale" &&
      /voice "lola" speaks es/.test(error.message) &&
      /not "en"/.test(error.message),
    "the refusal names the voice's Locale and the requested one",
  );
  // A tenant agent's voice binding is checked too: a Locale the bound voice
  // does not speak would measure a call the agent cannot conduct.
  assert.throws(
    () => resolveSubject({ agent: "agent_tenant_42", voice: "lola", locale: "fr" }),
    /voice "lola" speaks es/,
  );
});

test("an artifact carries the subject it measured and derives its own gates", () => {
  const lola = resolveSubject({ voice: "lola", explicit: true });
  const losa = artifactFor(lola, "lola", 900);
  const late = artifactFor(lola, "lola", REPLY_GAP_P95_BUDGET_MS + 5000);

  assert.deepEqual(losa.subject, lola, "the artifact carries the non-default subject");
  assert.equal(losa.voice, "lola");
  assert.equal(late.subject?.locale, "es");

  const pass = losa.gates.find((gate) => gate.name === "reply-gap")!;
  const fail = late.gates.find((gate) => gate.name === "reply-gap")!;
  assert.equal(pass.status, "PASS", pass.detail);
  assert.equal(fail.status, "FAIL", fail.detail);
  // The failing detail cites this run's own number, and the artifact names the
  // voice it belongs to: a verdict cannot be read without its subject.
  assert.match(fail.detail, /7500ms/);
  assert.equal(losa.subject?.agent.kind === "demo" && losa.subject.agent.voice, "lola");
});

test("a tenant artifact carries the agent and the phone transport", () => {
  const tenant = resolveSubject({
    agent: "agent_tenant_42",
    voice: "lola",
    locale: "es",
    transport: "phone",
    explicit: true,
  });
  const artifact = artifactFor(tenant, "lola", 900);
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
    voice: "lola",
    locale: "es",
    explicit: true,
  });
  const featuredArtifact = artifactFor(featured, DEFAULT_GATE_VOICE, 900);
  const tenantArtifact = artifactFor(tenant, "lola", REPLY_GAP_P95_BUDGET_MS + 5000);

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
    voice: "lola",
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
    voice: "lola",
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
  const lola = resolveSubject({ voice: "lola", explicit: true });
  assert.throws(
    () => artifactFor(lola, DEFAULT_GATE_VOICE, 900),
    (error: unknown) =>
      error instanceof SubjectError &&
      error.field === "agent" &&
      /not the demo subject's voice "lola"/.test(error.message),
  );
});

test("the compact report records the subject", () => {
  const tenant = resolveSubject({
    agent: "agent_tenant_42",
    voice: "lola",
    locale: "es",
    transport: "phone",
    explicit: true,
  });
  const artifact = artifactFor(tenant, "lola", 900);
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

test("score-demo records an explicit non-default subject in the artifact", () => {
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
      "lola",
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
  assert.deepEqual(artifact.subject, {
    agent: { kind: "demo", voice: "lola", agentId: null },
    locale: "es",
    transport: "phone",
    source: "flag",
  });
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
      "lola",
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
  const out = join(dir, "lola.json");
  const crossed = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      SCRIPT,
      "--dry-run",
      "--voice",
      "lola",
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
    ["--import", "tsx", SCRIPT, "--dry-run", "--voice", "lola", "--subject-locale", "xx", "--out", out],
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
  assert.equal(isCascadeSubjectVoice("lola"), true);
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

test("the German Locale is bound to jorg, not left open and not re-cast", () => {
  const german = localeSubjectStatus("de");
  assert.equal(german.locale, "de");
  assert.equal(german.status, "bound");
  assert.deepEqual(german.voices, ["jorg"], "the product voice is the only German subject");
  assert.equal(german.openReason, null);

  assert.deepEqual(
    LOCALE_SUBJECT_STATUSES,
    ["bound", "open"],
    "the vocabulary has no beta, dropped or cut-over state to hide behind",
  );

  // The historical id is a routing fact, not a mutation: naming it is refused
  // and German stays bound to the chosen voice.
  const before = cascadeSubjectList();
  assert.throws(() => resolveCascadeSubject({ voice: "juergen" }), SubjectError);
  assert.deepEqual(cascadeSubjectList(), before, "a refused voice never quietly drops its Locale");

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
    en: ["anna"],
    es: ["lola"],
    fr: ["estelle"],
    de: ["jorg"],
    it: ["giovanni"],
    pt: ["rafael"],
  });
  assert.equal(localeSubjectStatus("de").status, "bound", "German is bound to jorg, and says so");
});

test("the unbound table names historical ids, and every offered voice is measured", () => {
  for (const [voiceId, unbound] of Object.entries(UNBOUND_VOICES)) {
    assert.equal(unbound.historical, true, `${voiceId} is a historical row, not an offered voice`);
    assert.equal(getVoice(voiceId), undefined, `${voiceId} is no longer in the catalogue`);
    assert.equal(unbound.locale, "de", `${voiceId} keeps its Locale recorded`);
    assert.match(unbound.reason, /422 voice_not_found/);
  }
  assert.deepEqual(
    UNMEASURED_VOICE_LEVELS,
    [],
    "every offered voice, German included, has a measured native reference",
  );
});

test("a cascade subject carries its pipeline axis, so the A/B cannot merge", () => {
  const cascade = resolveCascadeSubject({ voice: "lola", explicit: true });
  assert.equal(cascade.pipeline, "cascade");
  assert.equal(formatSubject(cascade), "demo lola (es, browser, cascade)");

  const managed = resolveSubject({ voice: "lola", explicit: true });
  assert.equal(managed.pipeline, undefined, "a managed subject written before the axis stays managed");
  assert.equal(formatSubject(managed), "demo lola (es, browser)");

  assert.ok(!sameSubject(cascade, managed), "the same voice on two engines is two subjects");
  assert.ok(
    sameSubject(cascade, resolveCascadeSubject({ voice: "lola", explicit: true })),
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
