import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";
import { resolveSubject, type SubjectRecord } from "../src/lib/demo/subject";

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
    evalRunner: { scenario: "greeting-cut" },
    probes,
    transcripts: { redacted },
    ...extra,
  };
}

test("dry-run matrix writes one subject row per demo voice and a table that names each subject", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(
    ["--dry-run", "--voices", "anna,lola", "--out", out],
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
  assert.deepEqual(matrix.results.map((row) => row.voice), ["anna", "lola"]);
  assert.ok(matrix.results.every((r) => r.status === "PASS"), JSON.stringify(matrix.results));
  assert.ok(matrix.results.find((r) => r.voice === "anna")?.isFeatured);
  assert.ok(!matrix.results.find((r) => r.voice === "lola")?.isFeatured);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "PASS");
  // No carried featured verdict and no voice-keyed matrix fields.
  assert.equal("gate" in matrix, false, "there is no carried gate verdict");
  assert.equal("gateVoice" in matrix, false);
  assert.equal("voices" in matrix, false);
  assert.equal("gains" in matrix, false, "the matrix carries no gain rows");
  assert.match(result.stdout, /demo anna \(en, browser\)/);
  assert.match(result.stdout, /demo lola \(es, browser\)/);
  assert.doesNotMatch(result.stdout, /gain=/, "no applied gain is printed");
  assert.match(result.stdout, /2\/2 clean/);
});

test("dry-run matrix shows each subject's own verdict and sub-scores", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(
    ["--dry-run", "--voices", `${DEMO_VOICE_IDS[0]},${DEMO_VOICE_IDS[1]}`, "--out", out],
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
  assert.match(result.stdout, /demo anna \(en, browser\)/);
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
  const result = run(["--dry-run", "--voices", "anna,nope", "--out", out], new URL("../", import.meta.url).pathname);
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /unknown gate voice/);
});

test("--from re-analyzes saved runs: FAIL rows recorded, --strict fails the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  writeFileSync(
    join(from, "anna.json"),
    JSON.stringify(
      scoreArtifact(
        "anna",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        { gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }] },
      ),
    ),
  );
  writeFileSync(
    join(from, "lola.json"),
    JSON.stringify(scoreArtifact("lola", { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 }, ["send it with Lime 42 in the subject"])),
  );
  writeFileSync(
    join(from, "estelle.json"),
    JSON.stringify(scoreArtifact("estelle", { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 }, ["your tag is Coral 17"])),
  );

  const laxOut = join(dir, "lax.json");
  const lax = run(
    ["--from", from, "--voices", "anna,lola,estelle", "--out", laxOut],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(lax.status, 0, lax.stderr + lax.stdout);
  const laxMatrix = readMatrix(laxOut);
  assert.equal(laxMatrix.results.find((r) => r.voice === "anna")?.status, "PASS");
  const lola = laxMatrix.results.find((r) => r.voice === "lola");
  assert.equal(lola?.status, "FAIL");
  assert.ok(lola?.detail.includes("clip"));
  const estelle = laxMatrix.results.find((r) => r.voice === "estelle");
  assert.equal(estelle?.status, "FAIL");
  assert.ok(estelle?.detail.includes("coral 17"));
  assert.equal(laxMatrix.gates.find((g) => g.name === "matrix")?.status, "FAIL");
  assert.match(lax.stdout, /1\/3 clean/);

  const strictOut = join(dir, "strict.json");
  const strict = run(
    ["--from", from, "--voices", "anna,lola,estelle", "--out", strictOut, "--strict"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(strict.status, 0);
  assert.ok(existsSync(strictOut), "strict still writes the artifact before failing");
});

test("--from derives each subject's verdict from its own run, including a tenant row", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const tenant = resolveSubject({ agent: "agent_tenant_1", voice: "lola", locale: "es" });
  writeFileSync(
    join(from, "anna.json"),
    JSON.stringify(
      scoreArtifact(
        "anna",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        {
          subject: anna,
          runId: "run-anna-own",
          gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }],
        },
      ),
    ),
  );
  writeFileSync(
    join(from, "lola.json"),
    JSON.stringify(
      scoreArtifact(
        "lola",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        {
          subject: lola,
          runId: "run-lola-own",
          gates: [{ name: "barge-in-cut", status: "FAIL", detail: "cut 1841ms exceeds 1500ms" }],
        },
      ),
    ),
  );
  writeFileSync(
    join(from, "tenant.json"),
    JSON.stringify(
      scoreArtifact(
        "lola",
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
    ["--from", from, "--voices", "anna,lola", "--tenant", "agent_tenant_1,lola,es", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = readMatrix(out);
  assert.equal(matrix.results.length, 3);
  const annaRow = matrix.results.find((row) => row.voice === "anna");
  const lolaRow = matrix.results.find((row) => row.subject.agent.kind === "demo" && row.subject.agent.voice === "lola");
  const tenantRow = matrix.results.find((row) => row.subject.agent.kind === "tenant");
  assert.equal(annaRow?.status, "PASS");
  assert.equal(lolaRow?.status, "FAIL", "the demo lola row keeps its own failing gate");
  assert.equal(tenantRow?.status, "PASS", "the tenant row keeps its own passing gate");
  assert.equal(annaRow?.verdict?.runId, "run-anna-own");
  assert.equal(lolaRow?.verdict?.runId, "run-lola-own");
  assert.equal(tenantRow?.verdict?.runId, "run-tenant-own");
  assert.notEqual(lolaRow?.label, tenantRow?.label, "a tenant agent and its demo voice are distinct rows");
  assert.match(result.stdout, /tenant agent_tenant_1 \(es, browser\)/);
  assert.match(result.stdout, /demo lola \(es, browser\)/);
  assert.equal("gate" in matrix, false, "no featured verdict is carried");

  // --strict fails on the demo lola row even though the tenant row is green:
  // no row can borrow another row's verdict.
  const strict = run(
    ["--from", from, "--voices", "anna,lola", "--tenant", "agent_tenant_1,lola,es", "--out", join(dir, "strict.json"), "--strict"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(strict.status, 0);
});

test("--from judges a non-English row only after the featured subject passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  writeFileSync(
    join(from, "anna.json"),
    JSON.stringify(
      scoreArtifact(
        "anna",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        { gates: [{ name: "barge-in-cut", status: "FAIL", detail: "cut 1841ms exceeds 1500ms" }] },
      ),
    ),
  );
  writeFileSync(
    join(from, "lola.json"),
    JSON.stringify(
      scoreArtifact("lola", { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 }, [
        "send it with Lime 42 in the subject",
      ]),
    ),
  );

  const out = join(dir, "matrix.json");
  const result = run(
    ["--from", from, "--voices", "anna,lola", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = readMatrix(out);
  assert.equal(matrix.ordering.rule, "featured-first");
  assert.equal(matrix.ordering.featuredStatus, "FAIL");
  assert.match(matrix.ordering.detail, /blocked: featured subject demo anna \(en, browser\) has not passed/);
  assert.equal(matrix.results.find((row) => row.voice === "anna")?.status, "FAIL");
  const lola = matrix.results.find((row) => row.voice === "lola");
  assert.equal(lola?.status, "BLOCKED", "a passing lola run is not judged on a failed instrument");
  assert.equal(lola?.verdict, null);
  assert.match(lola?.detail ?? "", /blocked: featured subject demo anna/);
  assert.match(result.stdout, /ordering featured-first/);
  assert.match(result.stdout, /BLOCK\s+demo lola \(es, browser\).*blocked: featured subject demo anna/);
  assert.match(result.stdout, /0\/2 clean, 1 blocked/);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "FAIL");

  const strict = run(
    ["--from", from, "--voices", "anna,lola", "--out", join(dir, "strict.json"), "--strict"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(strict.status, 0, "--strict refuses a matrix where a Locale was never judged");
});

test("--from leaves a non-featured row blocked when the featured subject has no run", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  writeFileSync(
    join(from, "lola.json"),
    JSON.stringify(
      scoreArtifact("lola", { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 }, [
        "send it with Lime 42 in the subject",
      ]),
    ),
  );

  const out = join(dir, "matrix.json");
  const result = run(
    ["--from", from, "--voices", "lola", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = readMatrix(out);
  assert.equal(matrix.ordering.featuredStatus, null, "no featured run, no opened gate");
  assert.equal(matrix.results[0]?.status, "BLOCKED");
  assert.match(matrix.results[0]?.detail ?? "", /blocked: featured subject demo anna \(en, browser\) has not passed/);
  assert.match(result.stdout, /BLOCK\s+demo lola \(es, browser\)/);
});

test("--from reports a missing subject run as MISSING instead of copying another row", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  writeFileSync(
    join(from, "anna.json"),
    JSON.stringify(
      scoreArtifact(
        "anna",
        { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        ["send it with Lime 42 in the subject"],
        { gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }] },
      ),
    ),
  );
  const out = join(dir, "matrix.json");
  const result = run(
    ["--from", from, "--voices", "anna,lola", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(existsSync(out));
  const matrix = readMatrix(out);
  const lola = matrix.results.find((row) => row.voice === "lola" || row.subject.agent.kind === "demo" && row.subject.agent.voice === "lola");
  assert.equal(lola?.status, "MISSING");
  assert.equal(lola?.verdict, null, "no artifact means no verdict to inherit");
  assert.match(lola?.detail ?? "", /MISSING/);
  assert.match(result.stdout, /MISS\s+demo lola \(es, browser\).*MISSING/);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "FAIL");
  assert.ok(!readdirSync(from).includes("lola.json"), "the matrix invents no run file");
});
