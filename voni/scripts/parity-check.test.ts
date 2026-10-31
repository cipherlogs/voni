/**
 * The deploy parity check (ticket 20).
 *
 * The check is an operator command, so these tests exercise the command the
 * way an operator does: real flags, a real (in-process) call-body service, a
 * real routing switch over SQLite, and the process exit code. The service
 * fake verifies the exact bytes the app signs — the call token's claims, the
 * v2 envelope's claims and the HMAC over the canonical claims — so a signer
 * bump that changes the wire fails here first. No vendor host is contacted
 * and no WebSocket is opened; the fake records an upgrade attempt as a
 * failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  evaluateHostParity,
  parseRoutingShow,
  readBound,
  refusalName,
  tamperSignedBody,
  type Cited,
} from "./lib/parity";
import type { SignedBody } from "../src/lib/voice/envelope";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";

const SCRIPT = new URL("./parity-check.mts", import.meta.url).pathname;
const APP_ROOT = new URL("../", import.meta.url).pathname;
const ROUTING_SWITCH = new URL(
  "../../voice-pipeline/scripts/routing_switch.py",
  import.meta.url,
).pathname;

function cited(value: string, source: string): Cited {
  return { value, source };
}

/** The six rows a healthy configuration prints, in order. */
const HEALTHY = {
  pipeline: cited("https://pipe.example.com", "env VOICE_PIPELINE_URL"),
  service: cited("https://pipe.example.com", "flag --service-url"),
  toolBase: cited("https://app.example.com", "env VOICE_PIPELINE_TOOL_BASE_URL"),
  appOrigin: cited("https://app.example.com", "env BETTER_AUTH_URL"),
};

function failures(input: Parameters<typeof evaluateHostParity>[0]) {
  return evaluateHostParity(input).filter((row) => !row.ok);
}

test("a configuration that agrees points the pipeline and the tool base at each other", () => {
  const rows = evaluateHostParity(HEALTHY);
  assert.deepEqual(
    rows.map((row) => row.code),
    [
      "pipeline-url",
      "service-url",
      "pipeline-host",
      "tool-base-url",
      "app-origin",
      "tool-base-host",
    ],
  );
  assert.deepEqual(
    rows.filter((row) => !row.ok),
    [],
  );
});

test("the app's pipeline host must be the service the check talks to", () => {
  const rows = failures({
    ...HEALTHY,
    pipeline: cited("https://old-pipeline.example.com", "env VOICE_PIPELINE_URL"),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "pipeline-host-mismatch");
  assert.match(rows[0].detail, /old-pipeline\.example\.com/);
  assert.match(rows[0].detail, /pipe\.example\.com/);
  assert.match(rows[0].detail, /VOICE_PIPELINE_URL/);
});

test("a different port is a different deployment, and default ports are not", () => {
  assert.equal(
    failures({
      ...HEALTHY,
      pipeline: cited("https://pipe.example.com:8443", "env VOICE_PIPELINE_URL"),
    })[0]?.code,
    "pipeline-host-mismatch",
  );
  assert.deepEqual(
    failures({
      ...HEALTHY,
      pipeline: cited("https://pipe.example.com:443", "env VOICE_PIPELINE_URL"),
    }),
    [],
  );
});

test("the service's tool base must be the app's public origin", () => {
  const rows = failures({
    ...HEALTHY,
    toolBase: cited("https://staging.example.com", "env VOICE_PIPELINE_TOOL_BASE_URL"),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "tool-base-host-mismatch");
  assert.match(rows[0].detail, /staging\.example\.com/);
  assert.match(rows[0].detail, /app\.example\.com/);
  assert.match(rows[0].detail, /VOICE_PIPELINE_TOOL_BASE_URL/);
});

test("a scheme difference in the tool base is a mismatch: the origin is the app's", () => {
  const rows = failures({
    ...HEALTHY,
    toolBase: cited("http://app.example.com", "env VOICE_PIPELINE_TOOL_BASE_URL"),
  });
  assert.equal(rows[0]?.code, "tool-base-host-mismatch");
});

test("a missing host fails by name, and no host comparison is guessed", () => {
  const rows = failures({
    pipeline: cited("", "flag --pipeline-url / env VOICE_PIPELINE_URL"),
    service: cited("", "flag --service-url / env VOICE_PIPELINE_SERVICE_URL"),
    toolBase: cited("", "env VOICE_PIPELINE_TOOL_BASE_URL"),
    appOrigin: cited("", "flag --app-origin / env BETTER_AUTH_URL"),
  });
  assert.deepEqual(
    rows.map((row) => row.code),
    [
      "pipeline-url-missing",
      "service-url-missing",
      "tool-base-url-missing",
      "app-origin-missing",
    ],
  );
  for (const row of rows) {
    assert.match(row.detail, /not set/);
  }
  assert.doesNotMatch(rows[0].detail, /undefined|localhost/);
});

test("the pipeline URL keeps the app's https refusal", () => {
  const rows = failures({
    ...HEALTHY,
    pipeline: cited("http://pipe.example.com", "env VOICE_PIPELINE_URL"),
  });
  assert.equal(rows[0]?.code, "pipeline-url-insecure");
  assert.equal(
    failures({
      ...HEALTHY,
      pipeline: cited("not a url", "env VOICE_PIPELINE_URL"),
    })[0]?.code,
    "pipeline-url-invalid",
  );
});

test("a service URL with credentials or a query is refused, never printed", () => {
  const withCredentials = failures({
    ...HEALTHY,
    service: cited("https://user:pw@pipe.example.com", "flag --service-url"),
  });
  assert.equal(withCredentials[0]?.code, "service-url-invalid");
  assert.doesNotMatch(withCredentials[0].detail, /pw@/);
  assert.equal(
    failures({
      ...HEALTHY,
      service: cited("https://pipe.example.com?x=1", "flag --service-url"),
    })[0]?.code,
    "service-url-invalid",
  );
});

test("tampering changes the body bytes and leaves the signed envelope intact", () => {
  const signed: SignedBody = {
    envelope: {
      version: 2,
      kind: "demo",
      call_id: "call_throwaway",
      agent_id: "demo:audrey",
      body_hash: "a".repeat(64),
      issued_at_ms: 1,
      expires_at_ms: 2,
      signature: "b".repeat(64),
    },
    body: { name: "demo:voni:audrey", greeting: "Hi.", voice: { voice_id: "audrey" } },
  };
  const tampered = tamperSignedBody(signed);
  assert.deepEqual(tampered.envelope, signed.envelope);
  assert.notEqual(canonical(tampered.body), canonical(signed.body));
  // The original is never mutated: the accepted message stays the accepted one.
  assert.equal(canonical(signed.body), canonical({
    name: "demo:voni:audrey",
    greeting: "Hi.",
    voice: { voice_id: "audrey" },
  }));
});

test("a refusal is named by the service's machine-readable header, never its prose", () => {
  const cases: Array<[number, string, string]> = [
    [400, "envelope_refused", "envelope_refused"],
    [400, "malformed_body", "malformed_body"],
    [400, "duplicate_call_token", "duplicate_call_token"],
    [503, "envelope_secret_missing", "envelope_secret_missing"],
    [503, "draining", "draining"],
    [400, "ENVELOPE_REFUSED", "envelope_refused"],
  ];
  for (const [status, header, name] of cases) {
    assert.equal(refusalName(status, header), name, header);
  }
  assert.equal(refusalName(202, null), "Accepted");
  assert.equal(refusalName(400, "something nobody wrote down"), null);
  assert.equal(refusalName(400, ""), null);
  assert.equal(refusalName(500, null), null);
  // Prose that happens to match an old substring is no longer a refusal name:
  // only the header is the machine-readable source.
  assert.equal(
    refusalName(400, "does not match the signed envelope's body hash"),
    null,
  );
});

test("a routing view is only read when it is a real switch", () => {
  assert.deepEqual(parseRoutingShow('{"mode":"demo","recordVersion":3,"decidedAt":12,"missing":false,"failSafe":false,"changes":[]}'), {
    mode: "demo",
    recordVersion: 3,
    decidedAt: 12,
    missing: false,
  });
  assert.deepEqual(parseRoutingShow('{"mode":"off","recordVersion":null,"decidedAt":null,"missing":true,"failSafe":true,"changes":[]}'), {
    mode: "off",
    recordVersion: null,
    decidedAt: null,
    missing: true,
  });
  for (const bad of [
    "",
    "not json",
    '{"mode":"sometimes"}',
    '{"mode":"demo","missing":false}',
    '{"mode":"demo","recordVersion":"3","missing":false}',
  ]) {
    assert.throws(() => parseRoutingShow(bad), /routing/);
  }
});

test("a bound's value comes from the registry, and an unset bound is named", () => {
  const registry = {
    bounds: {
      "envelope.ttl_ms": { unit: "ms", value: 60000, source: "test", date: "2026-10-30" },
      "call_token.ttl_ms": { unit: "ms", ticket: "04", note: "open" },
    },
  };
  assert.equal(readBound(registry, "envelope.ttl_ms"), 60000);
  assert.throws(
    () => readBound(registry, "call_token.ttl_ms"),
    /call_token\.ttl_ms/,
  );
  assert.throws(() => readBound(registry, "no.such.bound"), /no\.such\.bound/);
});

/** The canonical JSON both signers claim; independent of the app's stableJson. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const SECRET = "parity-check-test-secret";
const VOICE = DEMO_VOICE_IDS[0];

type Seen = {
  payload: Record<string, unknown>;
  /** What the Python verifier would refuse, in its order; empty means accepted. */
  problems: string[];
  verdict: "accepted" | "body-hash" | "signature" | "malformed" | "token";
  callId: string | null;
  agentId: string | null;
  bodyHash: string | null;
};

const HEX64 = /^[0-9a-f]{64}$/;

function hmac(input: string): string {
  return createHmac("sha256", SECRET).update(input).digest("hex");
}

/** Verify one call-body payload the way `cascade/envelope.py` does. */
function verifyPayload(payload: Record<string, unknown>): Seen {
  const seen: Seen = {
    payload,
    problems: [],
    verdict: "malformed",
    callId: null,
    agentId: null,
    bodyHash: null,
  };
  const fields = Object.keys(payload).sort();
  if (fields.join(",") !== "call_id,call_token,signed_body") {
    seen.problems.push(`call body fields are ${fields.join(",")}`);
    return seen;
  }
  const signed = payload.signed_body as { envelope?: unknown; body?: unknown } | undefined;
  const envelope = signed?.envelope as Record<string, unknown> | undefined;
  const body = signed?.body;
  if (!envelope || typeof envelope !== "object" || body === null || typeof body !== "object") {
    seen.problems.push("the signed body has no envelope or no body");
    return seen;
  }
  const expectedClaims = [
    "agent_id",
    "body_hash",
    "call_id",
    "expires_at_ms",
    "issued_at_ms",
    "kind",
    "signature",
    "version",
  ];
  const claimKeys = Object.keys(envelope).sort();
  if (claimKeys.join(",") !== expectedClaims.join(",")) {
    seen.problems.push(`envelope claims are ${claimKeys.join(",")}`);
    return seen;
  }
  if (envelope.version !== 2) seen.problems.push(`envelope version is ${String(envelope.version)}`);
  if (envelope.kind !== "demo") seen.problems.push(`envelope kind is ${String(envelope.kind)}`);
  if (typeof envelope.call_id !== "string" || !envelope.call_id) {
    seen.problems.push('envelope field "call_id" must be a non-empty string');
  }
  if (typeof envelope.agent_id !== "string" || !envelope.agent_id) {
    seen.problems.push('envelope field "agent_id" must be a non-empty string');
  }
  if (
    typeof envelope.issued_at_ms !== "number" ||
    typeof envelope.expires_at_ms !== "number" ||
    envelope.expires_at_ms <= envelope.issued_at_ms
  ) {
    seen.problems.push("envelope expiry is not after issue");
  }
  if (typeof envelope.body_hash !== "string" || !HEX64.test(envelope.body_hash)) {
    seen.problems.push("envelope body_hash is not 64 lowercase hex");
  }
  if (typeof envelope.signature !== "string" || !HEX64.test(envelope.signature)) {
    seen.problems.push("envelope signature is not 64 lowercase hex");
  }
  seen.callId = typeof envelope.call_id === "string" ? envelope.call_id : null;
  seen.agentId = typeof envelope.agent_id === "string" ? envelope.agent_id : null;
  if (seen.problems.length > 0) return seen;

  const { signature, ...claims } = envelope;
  if (hmac(canonical(claims)) !== signature) {
    seen.verdict = "signature";
    seen.problems.push(`envelope for call "${seen.callId}" is not signed by the service secret`);
    return seen;
  }
  if (Date.now() >= (envelope.expires_at_ms as number)) {
    seen.problems.push(`envelope for call "${seen.callId}" expired`);
    return seen;
  }
  if (envelope.call_id !== payload.call_id) {
    seen.problems.push("envelope was minted for another call");
    return seen;
  }
  if (envelope.agent_id !== `demo:${VOICE}`) {
    seen.problems.push(`agent id is ${String(envelope.agent_id)}`);
    return seen;
  }

  // The short-TTL call token, checked against the same claims.
  const token = payload.call_token;
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts[0] !== "ct1") {
    seen.verdict = "token";
    seen.problems.push("the call token is not ct1 payload signature");
    return seen;
  }
  const tokenClaims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  if (hmac(canonical(tokenClaims)) !== parts[2]) {
    seen.verdict = "token";
    seen.problems.push("the call token signature does not verify");
    return seen;
  }
  if (tokenClaims.kind !== "call-token" || tokenClaims.version !== 1) {
    seen.verdict = "token";
    seen.problems.push("the call token is not a version 1 call token");
    return seen;
  }
  if (tokenClaims.call_id !== envelope.call_id) {
    seen.verdict = "token";
    seen.problems.push("the call token names another call");
    return seen;
  }
  if (tokenClaims.subject !== envelope.agent_id) {
    seen.verdict = "token";
    seen.problems.push("the call token names another subject");
    return seen;
  }
  if (Date.now() >= (tokenClaims.expires_at_ms as number)) {
    seen.verdict = "token";
    seen.problems.push("the call token expired");
    return seen;
  }

  const served = createHash("sha256").update(canonical(body)).digest("hex");
  seen.bodyHash = served;
  if (served !== envelope.body_hash) {
    seen.verdict = "body-hash";
    seen.problems.push(
      `the body served for call "${seen.callId}" hashes to "${served}", which does not match the signed envelope's body hash "${String(envelope.body_hash)}"`,
    );
    return seen;
  }
  seen.verdict = "accepted";
  return seen;
}

type FakeService = {
  url: string;
  seen: Seen[];
  upgrades: number;
  close: () => Promise<void>;
};

async function startCallBodyService(
  options: { forceStatus?: number; forceDetail?: string; forceCode?: string } = {},
): Promise<FakeService> {
  const service: FakeService = { url: "", seen: [], upgrades: 0, close: async () => {} };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/call-body") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "not found" }));
        return;
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const seen = verifyPayload(payload);
      service.seen.push(seen);
      if (options.forceStatus !== undefined) {
        response.writeHead(options.forceStatus, {
          "content-type": "application/json",
          ...(options.forceCode ? { "x-cascade-refusal": options.forceCode } : {}),
        });
        response.end(JSON.stringify({ detail: options.forceDetail ?? "refused" }));
        return;
      }
      if (seen.verdict === "accepted") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "accepted",
            call_id: seen.callId,
            agent_id: seen.agentId,
            body_hash: seen.bodyHash,
          }),
        );
        return;
      }
      response.writeHead(400, {
        "content-type": "application/json",
        "x-cascade-refusal": "envelope_refused",
      });
      response.end(JSON.stringify({ detail: seen.problems[0] ?? "refused" }));
    });
  });
  // A WebSocket attempt on this host is a refused connect: the check must never
  // open a call, so any upgrade is recorded and answered with a hard close.
  server.on("upgrade", (_request, socket) => {
    service.upgrades += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  service.url = `http://127.0.0.1:${address.port}`;
  service.close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  return service;
}

type RunResult = { status: number | null; stdout: string; stderr: string };

function stripParityEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const copy = { ...env };
  for (const name of [
    "VOICE_PIPELINE_URL",
    "VOICE_PIPELINE_SERVICE_URL",
    "VOICE_PIPELINE_TOOL_BASE_URL",
    "VOICE_PIPELINE_ENVELOPE_SECRET",
    "VONI_PUBLIC_ORIGIN",
    "BETTER_AUTH_URL",
    "VONI_API_URL",
    "DATABASE_URL",
    "CASCADE_STORE_PATH",
  ]) {
    delete copy[name];
  }
  return copy;
}

/** Spawn the command without blocking the in-process fake service. */
function runCheck(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      cwd: APP_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...stripParityEnv(process.env), ...env } as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function routingStore(mode: "off" | "demo" | "all"): string {
  const dir = mkdtempSync(join(tmpdir(), "parity-routing-"));
  const path = join(dir, "cascade.sqlite3");
  const set = spawnSync(
    "python3",
    [
      ROUTING_SWITCH,
      "set",
      "--mode",
      mode,
      "--operator",
      "parity-check-test",
      "--reason",
      "parity-check-test",
      "--sqlite",
      path,
    ],
    { encoding: "utf8" },
  );
  assert.equal(set.status, 0, set.stderr || set.stdout);
  return path;
}

function healthyArgs(serviceUrl: string, sqlite: string): string[] {
  return [
    "--pipeline-url",
    serviceUrl.replace("http:", "https:"),
    "--service-url",
    serviceUrl,
    "--tool-base-url",
    "https://app.example.com",
    "--app-origin",
    "https://app.example.com",
    "--sqlite",
    sqlite,
  ];
}

test("one run signs a throwaway body the service accepts, and a tampered one it refuses", async () => {
  const service = await startCallBodyService();
  try {
    const sqlite = routingStore("demo");
    const result = await runCheck(healthyArgs(service.url, sqlite), {
      VOICE_PIPELINE_ENVELOPE_SECRET: SECRET,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(service.seen.length, 2);
    assert.deepEqual(service.seen[0].problems, []);
    assert.equal(service.seen[0].verdict, "accepted");
    assert.equal(service.seen[0].agentId, `demo:${VOICE}`);
    assert.match(service.seen[0].callId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(service.seen[0].payload.call_id, service.seen[0].callId);

    // The second delivery is the same signed envelope with a changed body.
    assert.equal(service.seen[1].verdict, "body-hash");
    assert.deepEqual(
      (service.seen[1].payload.signed_body as { envelope: unknown }).envelope,
      (service.seen[0].payload.signed_body as { envelope: unknown }).envelope,
    );

    assert.match(result.stdout, /signed body/);
    assert.match(result.stdout, new RegExp(service.seen[0].bodyHash ?? "no-hash"));
    assert.match(result.stdout, /envelope_refused/);
    assert.match(result.stdout, /mode "demo"/);
    assert.match(result.stdout, /11 checks, all passed/);
    assert.equal(service.upgrades, 0, "no WebSocket may be opened");
  } finally {
    await service.close();
  }
});

test("every run mints a fresh random call id: no production id is ever reused", async () => {
  const service = await startCallBodyService();
  try {
    const sqlite = routingStore("demo");
    const first = await runCheck(healthyArgs(service.url, sqlite), {
      VOICE_PIPELINE_ENVELOPE_SECRET: SECRET,
    });
    const second = await runCheck(healthyArgs(service.url, sqlite), {
      VOICE_PIPELINE_ENVELOPE_SECRET: SECRET,
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const ids = service.seen.map((seen) => seen.callId);
    // Each run posts the same call twice (accepted, then tampered); the two
    // runs never share a call id.
    assert.equal(ids.length, 4);
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[2], ids[3]);
    assert.notEqual(ids[0], ids[2]);
    assert.ok(ids.every((id) => id !== null && !id.includes("demo_calls")));
  } finally {
    await service.close();
  }
});

test("host drift fails by name before a single body is signed", async () => {
  const service = await startCallBodyService();
  try {
    const sqlite = routingStore("demo");
    const args = healthyArgs(service.url, sqlite);
    args[1] = "https://old-pipeline.example.com";
    const result = await runCheck(args, { VOICE_PIPELINE_ENVELOPE_SECRET: SECRET });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /pipeline-host-mismatch/);
    assert.match(result.stdout, /old-pipeline\.example\.com/);
    assert.equal(service.seen.length, 0);
  } finally {
    await service.close();
  }
});

test("a service whose tool base is not the app's origin fails by name", async () => {
  const service = await startCallBodyService();
  try {
    const sqlite = routingStore("demo");
    const args = healthyArgs(service.url, sqlite);
    args[5] = "https://staging.example.com";
    const result = await runCheck(args, { VOICE_PIPELINE_ENVELOPE_SECRET: SECRET });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /tool-base-host-mismatch/);
    assert.equal(service.seen.length, 0);
  } finally {
    await service.close();
  }
});

test("a missing host is refused by name", async () => {
  const service = await startCallBodyService();
  try {
    const sqlite = routingStore("demo");
    const args = healthyArgs(service.url, sqlite);
    args.splice(2, 2); // drop --service-url and its value
    const result = await runCheck(args, { VOICE_PIPELINE_ENVELOPE_SECRET: SECRET });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /service-url-missing/);
    assert.match(result.stdout, /--service-url/);
    assert.match(result.stdout, /VOICE_PIPELINE_SERVICE_URL/);
    assert.equal(service.seen.length, 0);
  } finally {
    await service.close();
  }
});

test("a missing envelope secret stops before the service is called", async () => {
  const service = await startCallBodyService();
  try {
    const sqlite = routingStore("demo");
    const result = await runCheck(healthyArgs(service.url, sqlite));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /envelope-secret-missing/);
    assert.match(result.stdout, /VOICE_PIPELINE_ENVELOPE_SECRET/);
    assert.equal(service.seen.length, 0);
  } finally {
    await service.close();
  }
});


test("a switch that is off is printed, not treated as a failure", async () => {
  const service = await startCallBodyService();
  try {
    const sqlite = routingStore("off");
    const result = await runCheck(healthyArgs(service.url, sqlite), {
      VOICE_PIPELINE_ENVELOPE_SECRET: SECRET,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS {2}routing switch {2,}mode "off"/);
  } finally {
    await service.close();
  }
});

test("an unreadable routing switch fails the run after the signed body checks", async () => {
  const service = await startCallBodyService();
  try {
    const dir = mkdtempSync(join(tmpdir(), "parity-routing-bad-"));
    const corrupt = join(dir, "cascade.sqlite3");
    writeFileSync(corrupt, "this is not a database\n");
    const result = await runCheck(healthyArgs(service.url, corrupt), {
      VOICE_PIPELINE_ENVELOPE_SECRET: SECRET,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /routing-switch-unreadable/);
    assert.match(result.stdout, /FAIL {2}routing switch/);
    // The sign/tamper proof ran; only the switch is unreadable.
    assert.equal(service.seen.length, 2);
  } finally {
    await service.close();
  }
});

test("no routing store configured is unreadable, never a silent off", async () => {
  const service = await startCallBodyService();
  try {
    const args = healthyArgs(service.url, "");
    args.splice(-2, 2); // drop --sqlite and its empty value
    const result = await runCheck(args, { VOICE_PIPELINE_ENVELOPE_SECRET: SECRET });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /routing-switch-unreadable/);
    assert.match(result.stdout, /--sqlite/);
  } finally {
    await service.close();
  }
});

test("a service that refuses the accepted body fails by name", async () => {
  const service = await startCallBodyService({
    forceStatus: 503,
    forceCode: "envelope_secret_missing",
    forceDetail:
      "the signed-body channel is closed: set VOICE_PIPELINE_ENVELOPE_SECRET in the service host's environment so a delivered body can be verified",
  });
  try {
    const sqlite = routingStore("demo");
    const result = await runCheck(healthyArgs(service.url, sqlite), {
      VOICE_PIPELINE_ENVELOPE_SECRET: SECRET,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /signed-body-refused/);
    assert.match(result.stdout, /envelope_secret_missing/);
  } finally {
    await service.close();
  }
});

test("a refusal the check has never seen is a failure, not a pass", async () => {
  const service = await startCallBodyService({
    forceStatus: 400,
    // Prose that used to be classified by substring: with no header it is
    // still unrecognised, because the header is the machine-readable source.
    forceDetail:
      'the body served for call "c" does not match the signed envelope\'s body hash "a"',
  });
  try {
    const sqlite = routingStore("demo");
    const result = await runCheck(healthyArgs(service.url, sqlite), {
      VOICE_PIPELINE_ENVELOPE_SECRET: SECRET,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /unrecognised refusal/);
  } finally {
    await service.close();
  }
});

test("--json reports the same evidence for automation", async () => {
  const service = await startCallBodyService();
  try {
    const sqlite = routingStore("demo");
    const result = await runCheck([...healthyArgs(service.url, sqlite), "--json"], {
      VOICE_PIPELINE_ENVELOPE_SECRET: SECRET,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ code: string; ok: boolean }>;
      accepted: { callId: string; agentId: string; bodyHash: string };
      refusal: { status: number; name: string };
      routing: { mode: string; store: string };
    };
    assert.equal(report.ok, true);
    assert.ok(report.checks.every((check) => check.ok));
    assert.equal(report.accepted.agentId, `demo:${VOICE}`);
    assert.equal(report.accepted.bodyHash, service.seen[0].bodyHash);
    assert.deepEqual(report.refusal, { status: 400, name: "envelope_refused" });
    assert.equal(report.routing.mode, "demo");
    assert.match(report.routing.store, /^sqlite /);
  } finally {
    await service.close();
  }
});
