/**
 * The one-command local cascade launcher (demo-cascade ticket 21).
 *
 * These tests are the launcher's contract. They fail if a required process, a
 * port, an environment name, or the https requirement goes missing, and they
 * prove the app and the service are handed the same envelope secret and the
 * same pipeline origin.
 *
 * The expected values come from the ticket and the deploy contract, not from
 * the code under test: pipeline 8766, its Postgres 5433, the app 3000, one
 * `VOICE_PIPELINE_URL` that must be https, and one shared
 * `VOICE_PIPELINE_ENVELOPE_SECRET`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENV,
  PORTS,
  PROCESSES,
  REQUIRED_ENV,
  cascadeEnv,
  collectBlockers,
  localAppOrigin,
  localPipelineUrl,
  pipelineDatabaseUrl,
  resolveEnvelopeSecret,
  tlsPlan,
} from "./dev-cascade-lib.mjs";
import { readPipelineUrl } from "../src/lib/voice/pipeline-url";

const here = dirname(fileURLToPath(import.meta.url));

test("the launcher starts every required process on its named port", () => {
  const byName = new Map(
    (PROCESSES as ReadonlyArray<{ name: string; port: number }>).map((p) => [
      p.name,
      p.port,
    ]),
  );

  // The acceptance ports are fixed by the ticket: pipeline 8766, its dedicated
  // Postgres 5433, the app 3000. The TLS front owns 8766 and forwards to an
  // internal plain port so the browser's wss URL is the configured https base.
  assert.equal(byName.get("postgres"), 5433);
  assert.equal(byName.get("pipeline-tls"), 8766);
  assert.equal(byName.get("pipeline"), 8767);
  assert.equal(byName.get("app"), 3000);

  assert.equal(PORTS.postgres, 5433);
  assert.equal(PORTS.pipeline, 8766);
  assert.equal(PORTS.pipelineInternal, 8767);
  assert.equal(PORTS.app, 3000);
});

test("the app is configured with an https pipeline base the reader accepts", () => {
  const base = localPipelineUrl();
  assert.equal(base, "https://localhost:8766");

  const result = readPipelineUrl(base);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Ticket 08: the browser URL is derived from the one https base.
  assert.equal(result.wsUrl, "wss://localhost:8766/v1/browser-call");
  assert.equal(result.baseUrl, "https://localhost:8766");
});

test("the launcher never produces a plain-http pipeline base", () => {
  const result = readPipelineUrl("http://localhost:8766");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "insecure");
  assert.match(result.error.message, /https/);
});

test("the app and the service are handed the same secret and the same origins", () => {
  const secret = "a-shared-test-secret-value";
  const { app, pipeline } = cascadeEnv({ envelopeSecret: secret });

  // One value on both sides — the envelope secret is not regenerated per side.
  assert.equal(app[ENV.envelopeSecret], secret);
  assert.equal(pipeline[ENV.envelopeSecret], secret);

  // The app reads exactly one runtime pipeline URL, and it is https.
  assert.equal(app[ENV.pipelineUrl], localPipelineUrl());
  assert.match(app[ENV.pipelineUrl], /^https:\/\//);

  // The service's tool base is the app origin, and its store is the dedicated
  // Postgres on 5433 — not the app's own DATABASE_URL.
  assert.equal(pipeline[ENV.toolBaseUrl], localAppOrigin());
  assert.equal(pipeline[ENV.databaseUrl], pipelineDatabaseUrl());
  assert.match(pipeline[ENV.databaseUrl], /127\.0\.0\.1:5433\//);

  // Nothing is baked into the browser bundle (ticket 08 deleted it).
  assert.equal(
    Object.keys(app).filter((name) => name.startsWith("NEXT_PUBLIC_")).length,
    0,
  );
});

test("a configured envelope secret wins; an absent one is generated per run", () => {
  const configured = resolveEnvelopeSecret("from-env", () => {
    throw new Error("must not generate when configured");
  });
  assert.equal(configured, "from-env");

  const generated = resolveEnvelopeSecret("   ", () =>
    "generated-secret-0123456789abcdef",
  );
  assert.equal(generated, "generated-secret-0123456789abcdef");

  // The default generator must be real randomness, never a constant.
  const first = resolveEnvelopeSecret("");
  const second = resolveEnvelopeSecret("");
  assert.ok(first.length >= 32);
  assert.notEqual(first, second);
});

test("the TLS plan uses a supplied cert or generates a gitignored dev cert", () => {
  const supplied = tlsPlan({
    env: {
      VOICE_PIPELINE_TLS_CERT: "/tmp/test.crt",
      VOICE_PIPELINE_TLS_KEY: "/tmp/test.key",
    },
    fileExists: (path: string) => path.startsWith("/tmp/test."),
    opensslAvailable: false,
  });
  assert.equal(supplied.ok, true);
  if (!supplied.ok) return;
  assert.equal(supplied.source, "env");
  assert.equal(supplied.certPath, "/tmp/test.crt");
  assert.equal(supplied.keyPath, "/tmp/test.key");

  const generated = tlsPlan({
    env: {},
    fileExists: () => false,
    opensslAvailable: true,
    devCertDir: "/tmp/dev-certs",
  });
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  assert.equal(generated.source, "generated");
  assert.match(generated.certPath, /dev-certs\/pipeline\.crt$/);
  assert.match(generated.keyPath, /dev-certs\/pipeline\.key$/);
});

test("the TLS plan fails loudly instead of falling back to http", () => {
  // Half a pair is a configuration error, named exactly.
  const half = tlsPlan({
    env: { VOICE_PIPELINE_TLS_CERT: "/tmp/only.crt" },
    fileExists: () => true,
    opensslAvailable: true,
  });
  assert.equal(half.ok, false);
  if (half.ok) return;
  assert.match(half.blocker, /VOICE_PIPELINE_TLS_KEY/);

  // No cert and no openssl names the tool that is missing.
  const noTool = tlsPlan({
    env: {},
    fileExists: () => false,
    opensslAvailable: false,
  });
  assert.equal(noTool.ok, false);
  if (noTool.ok) return;
  assert.match(noTool.blocker, /openssl/);
  assert.match(noTool.blocker, /VOICE_PIPELINE_TLS_CERT/);
});

test("preflight refuses named variables, occupied ports and a missing runtime", () => {
  // The launcher's required-name list is part of the contract: a demo call
  // needs the app database/auth, both vendor legs, and the measured effort.
  for (const name of [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "ASSEMBLYAI_API_KEY",
    "META_API_KEY",
    "META_REASONING_EFFORT",
  ]) {
    assert.ok(REQUIRED_ENV.includes(name), `${name} must be a required name`);
  }

  const clean = {
    env: Object.fromEntries(REQUIRED_ENV.map((name) => [name, "x"])),
    python: { ok: true, path: "/tmp/python", missingModules: [] as string[] },
    occupied: [] as string[],
    cert: { ok: true as const, source: "generated", certPath: "c", keyPath: "k" },
  };
  assert.deepEqual(collectBlockers(clean), []);

  const missingKeys = collectBlockers({ ...clean, env: {} });
  const joined = missingKeys.join("\n");
  assert.match(joined, /DATABASE_URL/);
  assert.match(joined, /ASSEMBLYAI_API_KEY/);

  const busy = collectBlockers({ ...clean, occupied: [":8766", ":5433"] });
  assert.match(busy.join("\n"), /:8766/);
  assert.match(busy.join("\n"), /:5433/);

  const noPython = collectBlockers({
    ...clean,
    python: { ok: false, path: "", missingModules: ["websockets"] },
  });
  assert.match(noPython.join("\n"), /websockets/);

  const noCert = collectBlockers({
    ...clean,
    cert: { ok: false as const, blocker: "openssl missing" },
  });
  assert.match(noCert.join("\n"), /openssl/);
});

test("the launcher names every process and port it reports", () => {
  const source = readFileSync(resolve(here, "dev-cascade.mjs"), "utf8");
  // The launcher must take the process list from the contract module, not
  // keep a second copy that can drift from the test's expectations.
  assert.match(source, /PROCESSES/);
  for (const name of PROCESSES.map((p) => p.name)) {
    assert.match(source, new RegExp(name));
  }
  // A hardcoded pipeline URL or secret would defeat the runtime contract.
  assert.doesNotMatch(source, /wss?:\/\/(?!localhost|127\.0\.0\.1)/);
  const literalSecret = source.match(
    /VOICE_PIPELINE_ENVELOPE_SECRET\s*[:=]\s*["'][^"']{16,}["']/,
  );
  assert.equal(literalSecret, null);
});
