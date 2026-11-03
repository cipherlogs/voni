import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";
import { readCodeFingerprint } from "../src/lib/demo/scoreboard";
import { resolveSubject, sameSubject, type SubjectRecord } from "../src/lib/demo/subject";

const SCRIPT = new URL("./score-matrix.mts", import.meta.url).pathname;

function run(args: string[], cwd: string) {
  return spawnSync("node", ["--import", "tsx", SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH },
  });
}

type MatrixJson = {
  schemaVersion: number;
  featuredSubject: SubjectRecord;
  ordering: {
    rule: string;
    featuredStatus: string | null;
    detail: string;
    blocked: string[];
  };
  subjects: SubjectRecord[];
  results: {
    subject: SubjectRecord;
    label: string;
    voice: string | null;
    isFeatured: boolean;
    status: string;
    detail: string;
    verdict: {
      runId: string;
      status: string;
      failing: string[];
      gates: { name: string; status: string }[];
    } | null;
    subScores: { name: string; status: string }[];
  }[];
  gates: { name: string; status: string; detail: string }[];
};

function readMatrix(path: string): MatrixJson {
  return JSON.parse(readFileSync(path, "utf8")) as MatrixJson;
}

function scoreArtifact(voice: string, probes: Record<string, number>, redacted: string[], extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    recordedAt: "2026-10-29T12:00:00.000Z",
    gates: [],
    subScores: [],
    voice,
    runId: `run-${voice}`,
    // The matrix judges the current tree (ticket 117): a saved run without a
    // fingerprint is historical and cannot answer for this matrix.
    codeFingerprint: readCodeFingerprint(),
    evalRunner: { scenario: "greeting-cut" },
    probes,
    transcripts: { redacted },
    ...extra,
  };
}

test("the matrix spawn order and the row order share one featured-first rule", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /orderFeaturedFirst/, "the CLI orders its spawn list with the shared rule");
  assert.doesNotMatch(source, /function featuredFirst\(/, "there is no second copy of the ordering rule");
});

test("dry-run matrix writes one subject row for the single demo voice", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(
    ["--dry-run", "--voices", "audrey", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(existsSync(out), "matrix artifact exists");
  const matrix = readMatrix(out);
  assert.equal(matrix.schemaVersion, 4);
  assert.equal(matrix.featuredSubject.agent.kind, "demo");
  assert.equal(
    matrix.featuredSubject.agent.kind === "demo" ? matrix.featuredSubject.agent.voice : "",
    DEMO_VOICE_IDS[0],
    "the featured subject is the registry default, never a row's verdict",
  );
  assert.deepEqual(matrix.results.map((row) => row.voice), ["audrey"]);
  assert.ok(matrix.results.every((r) => r.status === "PASS"), JSON.stringify(matrix.results));
  assert.ok(matrix.results.find((r) => r.voice === "audrey")?.isFeatured);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "PASS");
  // No carried featured verdict and no voice-keyed matrix fields.
  assert.equal("gate" in matrix, false, "there is no carried gate verdict");
  assert.equal("gateVoice" in matrix, false);
  assert.equal("voices" in matrix, false);
  assert.equal("gains" in matrix, false, "the matrix carries no gain rows");
  assert.match(result.stdout, /demo audrey \(en, browser\)/);
  assert.doesNotMatch(result.stdout, /gain=/, "no applied gain is printed");
  assert.match(result.stdout, /1\/1 clean/);
});

test("a withdrawn demo voice is refused by name with no artifact", () => {
  for (const voice of ["malvina", "donatien", "jorg", "benicio"]) {
    const dir = mkdtempSync(join(tmpdir(), "matrix-"));
    const out = join(dir, "matrix.json");
    const result = run(["--dry-run", "--voices", voice, "--out", out], new URL("../", import.meta.url).pathname);
    assert.notEqual(result.status, 0, `${voice} is withdrawn from the English-only roster`);
    assert.ok(!existsSync(out), `no artifact is written for withdrawn voice ${voice}`);
    assert.match(result.stderr + result.stdout, /unknown gate voice/);
  }
});

test("dry-run matrix shows the single subject's own verdict and sub-scores", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(
    ["--dry-run", "--voices", `${DEMO_VOICE_IDS[0]}`, "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = readMatrix(out);
  const featured = matrix.results.find((row) => row.isFeatured);
  assert.equal(featured?.voice, DEMO_VOICE_IDS[0]);
  assert.equal(featured?.verdict?.status, "PASS", "the featured row's own artifact passed");
  assert.ok(featured?.verdict?.gates.some((g) => g.name === "plumbing"));
  assert.equal(featured?.subScores.length, 5);
  assert.ok(matrix.results.every((row) => row.verdict !== null));
  assert.equal(new Set(matrix.results.map((row) => row.verdict?.runId)).size, matrix.results.length);
  assert.match(result.stdout, /demo audrey \(en, browser\)/);
  assert.match(result.stdout, /sub-scores responsiveness/);
});

test("dry-run matrix defaults to every registry voice", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(["--dry-run", "--out", out], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = readMatrix(out);
  assert.deepEqual(
    matrix.results.map((row) => row.voice).sort(),
    [...DEMO_VOICE_IDS].sort(),
  );
});

test("unknown matrix voice fails fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(["--dry-run", "--voices", "audrey,nope", "--out", out], new URL("../", import.meta.url).pathname);
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /unknown gate voice/);
});

test("--from re-analyzes saved runs: FAIL rows recorded, --strict fails the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  writeFileSync(
    join(from, "audrey.json"),
    JSON.stringify(
      scoreArtifact(
        "audrey",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        { gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }] },
      ),
    ),
  );
  // English-only: the second row is a tenant subject (the catalogue voice via
  // the --agent path), never a withdrawn demo voice.
  const tenant = resolveSubject({ agent: "agent_tenant_1", voice: "audrey", locale: "en" });
  writeFileSync(
    join(from, "tenant.json"),
    JSON.stringify(
      scoreArtifact(
        "audrey",
        { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        {
          subject: tenant,
          runId: "run-tenant-own",
          gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }],
        },
      ),
    ),
  );

  const laxOut = join(dir, "lax.json");
  const lax = run(
    ["--from", from, "--voices", "audrey", "--tenant", "agent_tenant_1,audrey,en", "--out", laxOut],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(lax.status, 0, lax.stderr + lax.stdout);
  const laxMatrix = readMatrix(laxOut);
  assert.equal(laxMatrix.results.find((r) => r.subject.agent.kind === "demo")?.status, "PASS");
  const tenantRow = laxMatrix.results.find((r) => r.subject.agent.kind === "tenant");
  assert.equal(tenantRow?.status, "FAIL");
  assert.ok(tenantRow?.detail.includes("clip"));
  assert.equal(laxMatrix.gates.find((g) => g.name === "matrix")?.status, "FAIL");
  assert.match(lax.stdout, /1\/2 clean/);

  const strictOut = join(dir, "strict.json");
  const strict = run(
    ["--from", from, "--voices", "audrey", "--tenant", "agent_tenant_1,audrey,en", "--out", strictOut, "--strict"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(strict.status, 0);
  assert.ok(existsSync(strictOut), "strict still writes the artifact before failing");
});

test("--from derives each subject's verdict from its own run, including a tenant row", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  const audrey = resolveSubject({ voice: "audrey" });
  const tenantDemo = resolveSubject({ agent: "agent_tenant_1", voice: "audrey", locale: "en" });
  const tenant = resolveSubject({ agent: "agent_tenant_2", voice: "audrey", locale: "en" });
  writeFileSync(
    join(from, "audrey.json"),
    JSON.stringify(
      scoreArtifact(
        "audrey",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        {
          subject: audrey,
          runId: "run-audrey-own",
          gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }],
        },
      ),
    ),
  );
  writeFileSync(
    join(from, "tenant-demo.json"),
    JSON.stringify(
      scoreArtifact(
        "audrey",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        {
          subject: tenantDemo,
          runId: "run-tenant-demo-own",
          gates: [{ name: "barge-in-cut", status: "FAIL", detail: "cut 1841ms exceeds 1500ms" }],
        },
      ),
    ),
  );
  writeFileSync(
    join(from, "tenant.json"),
    JSON.stringify(
      scoreArtifact(
        "audrey",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        {
          subject: tenant,
          runId: "run-tenant-own",
          gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }],
        },
      ),
    ),
  );

  const out = join(dir, "matrix.json");
  const result = run(
    ["--from", from, "--voices", "audrey", "--tenant", "agent_tenant_1,audrey,en", "--tenant", "agent_tenant_2,audrey,en", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = readMatrix(out);
  assert.equal(matrix.results.length, 3);
  const annaRow = matrix.results.find((row) => row.voice === "audrey" && row.subject.agent.kind === "demo");
  const demoVoiceRow = matrix.results.find((row) => sameSubject(row.subject, tenantDemo));
  const tenantRow = matrix.results.find((row) => sameSubject(row.subject, tenant));
  assert.equal(annaRow?.status, "PASS");
  assert.equal(demoVoiceRow?.status, "FAIL", "the tenant row sharing the demo voice keeps its own failing gate");
  assert.equal(tenantRow?.status, "PASS", "the tenant row keeps its own passing gate");
  assert.equal(annaRow?.verdict?.runId, "run-audrey-own");
  assert.equal(demoVoiceRow?.verdict?.runId, "run-tenant-demo-own");
  assert.equal(tenantRow?.verdict?.runId, "run-tenant-own");
  assert.notEqual(demoVoiceRow?.label, tenantRow?.label, "two tenant agents are distinct rows");
  assert.match(result.stdout, /tenant agent_tenant_1 \(en, browser\)/);
  assert.match(result.stdout, /tenant agent_tenant_2 \(en, browser\)/);
  assert.equal("gate" in matrix, false, "no featured verdict is carried");

  // --strict fails on the failing tenant row even though the other tenant row is green:
  // no row can borrow another row's verdict.
  const strict = run(
    ["--from", from, "--voices", "audrey", "--tenant", "agent_tenant_1,audrey,en", "--tenant", "agent_tenant_2,audrey,en", "--out", join(dir, "strict.json"), "--strict"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(strict.status, 0);
});

test("--from judges a tenant row only after the featured subject passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  writeFileSync(
    join(from, "audrey.json"),
    JSON.stringify(
      scoreArtifact(
        "audrey",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        { gates: [{ name: "barge-in-cut", status: "FAIL", detail: "cut 1841ms exceeds 1500ms" }] },
      ),
    ),
  );
  const tenant = resolveSubject({ agent: "agent_tenant_1", voice: "audrey", locale: "en" });
  writeFileSync(
    join(from, "tenant.json"),
    JSON.stringify(
      scoreArtifact(
        "audrey",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        { subject: tenant, runId: "run-tenant-own" },
      ),
    ),
  );

  const out = join(dir, "matrix.json");
  const result = run(
    ["--from", from, "--voices", "audrey", "--tenant", "agent_tenant_1,audrey,en", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = readMatrix(out);
  assert.equal(matrix.ordering.rule, "featured-first");
  assert.equal(matrix.ordering.featuredStatus, "FAIL");
  assert.match(matrix.ordering.detail, /blocked: featured subject demo audrey \(en, browser\) has not passed/);
  assert.equal(matrix.results.find((row) => row.subject.agent.kind === "demo")?.status, "FAIL");
  const blocked = matrix.results.find((row) => row.subject.agent.kind === "tenant");
  assert.equal(blocked?.status, "BLOCKED", "a passing tenant run is not judged on a failed instrument");
  assert.equal(blocked?.verdict, null);
  assert.match(blocked?.detail ?? "", /blocked: featured subject demo audrey/);
  assert.match(result.stdout, /ordering featured-first/);
  assert.match(result.stdout, /BLOCK\s+tenant agent_tenant_1 \(en, browser\).*blocked: featured subject demo audrey/);
  assert.match(result.stdout, /0\/2 clean, 1 blocked/);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "FAIL");

  const strict = run(
    ["--from", from, "--voices", "audrey", "--tenant", "agent_tenant_1,audrey,en", "--out", join(dir, "strict.json"), "--strict"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(strict.status, 0, "--strict refuses a matrix where a subject was never judged");
});

test("--from leaves a tenant row blocked when the featured subject has no run", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  const tenant = resolveSubject({ agent: "agent_tenant_1", voice: "audrey", locale: "en" });
  writeFileSync(
    join(from, "tenant.json"),
    JSON.stringify(
      scoreArtifact(
        "audrey",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        { subject: tenant, runId: "run-tenant-own" },
      ),
    ),
  );

  const out = join(dir, "matrix.json");
  const result = run(
    ["--from", from, "--tenant", "agent_tenant_1,audrey,en", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = readMatrix(out);
  assert.equal(matrix.ordering.featuredStatus, "MISSING", "no featured run, no opened gate");
  assert.equal(matrix.results[0]?.subject.agent.kind, "demo", "the featured row leads");
  assert.equal(matrix.results[0]?.status, "MISSING", "the featured subject has no run");
  const blocked = matrix.results.find((row) => row.subject.agent.kind === "tenant");
  assert.equal(blocked?.status, "BLOCKED");
  assert.match(blocked?.detail ?? "", /blocked: featured subject demo audrey \(en, browser\) has not passed/);
  assert.match(result.stdout, /BLOCK\s+tenant agent_tenant_1 \(en, browser\)/);
});

test("--from reports a missing subject run as MISSING instead of copying another row", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  writeFileSync(
    join(from, "audrey.json"),
    JSON.stringify(
      scoreArtifact(
        "audrey",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        { gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }] },
      ),
    ),
  );
  const out = join(dir, "matrix.json");
  const result = run(
    ["--from", from, "--voices", "audrey", "--tenant", "agent_tenant_1,audrey,en", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(existsSync(out));
  const matrix = readMatrix(out);
  const missing = matrix.results.find((row) => row.subject.agent.kind === "tenant");
  assert.equal(missing?.status, "MISSING");
  assert.equal(missing?.verdict, null, "no artifact means no verdict to inherit");
  assert.match(missing?.detail ?? "", /MISSING/);
  assert.match(result.stdout, /MISS\s+tenant agent_tenant_1 \(en, browser\).*MISSING/);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "FAIL");
  assert.ok(!readdirSync(from).includes("tenant.json"), "the matrix invents no run file");
});
