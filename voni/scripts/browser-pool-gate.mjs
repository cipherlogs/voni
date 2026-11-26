#!/usr/bin/env node
/**
 * The pool gate: the step between a dispatched Segment and its first Click.
 *
 * The runner has no direct fallback while the pool is on. This is the refusal:
 * it reads the client's loopback `/health`, waits a bounded three minutes for at
 * least three ready US exits, and exits non-zero — before any browser exists —
 * when they do not arrive. A failed step skips the click step, so a gate that
 * fails produces zero click rows and one artifact that says why.
 *
 * It also writes `pool-report.json`: the exits and their cities and ASNs, the
 * refills and reconnects the pool spent, and the failure when there was one.
 * `--final` rewrites just the end-of-run half of that file, after the clicks and
 * before the client is stopped, so a five-hour segment reports the churn it
 * actually saw rather than only what the gate saw at the start.
 *
 * Nothing here holds a browser or an account: it reads a loopback address and a
 * health report. Any credential in that report is redacted before it is written,
 * because an artifact outlives the run and a log is a place credentials go to
 * die.
 *
 * Usage:
 *   node --import tsx scripts/browser-pool-gate.mjs
 *   node --import tsx scripts/browser-pool-gate.mjs --final
 *   node --import tsx scripts/browser-pool-gate.mjs --report /tmp/pool-report.json
 *
 * Exit: 0 the gate passed (or, with `--final`, the snapshot was written);
 *       1 the pool is short of exits or the client is broken; 2 the gate was
 *       asked to run while `TUXLER_ENABLED` is not "true".
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parseControlUrl } from "./browser-exit-pool.mjs";

/** The gate the ticket names: a Click may start with three exits in hand. */
export const POOL_GATE_MIN_READY = 3;
/** Three minutes: a refill plus a handshake, twice over, and no longer. */
export const POOL_GATE_TIMEOUT_MS = 180_000;
/** A poll is cheap; a tight loop against the client is not. */
export const POOL_GATE_POLL_MS = 2_000;
/** One health read may not outlive the gate it is trying to pass. */
export const POOL_GATE_READ_TIMEOUT_MS = 10_000;
/** Relative to `voni/`, where the workflow runs its steps. */
export const POOL_REPORT_PATH = "pool-report.json";
/** The start step's redirect target; its tail is the client's own reason. */
export const POOL_CLIENT_LOG_PATH = "tuxler-client.log";

/**
 * Character bound for the quoted log tail. The report parser refuses a long
 * string field beyond 16 000 characters, and a report it refuses is a report the
 * intake never stores, so the quote stays well inside that.
 */
export const MAX_CLIENT_LOG_CHARS = 12_000;

/** The variables a client logs in with. Read only so a report can scrub them. */
export const CREDENTIAL_ENV_NAMES = [
  "TUXLER_EMAIL",
  "TUXLER_USERNAME",
  "TUXLER_PASSWORD",
  "TUXLER_PASSWD",
];

/** A short value is a word, not a credential; replacing it would eat the report. */
const MIN_REDACTED_LENGTH = 4;

function firstLine(message) {
  return message.split("\n")[0].trim();
}

/**
 * The flag, in three states: on, off, and a typo. Off is the default — an
 * unset repository variable is an empty string, and empty is not "true".
 *
 * @returns {"true" | "false" | "unknown"}
 */
export function readFlag(env = process.env) {
  const raw = typeof env.TUXLER_ENABLED === "string" ? env.TUXLER_ENABLED.trim() : "";
  if (raw === "" || raw === "false") return "false";
  if (raw === "true") return "true";
  return "unknown";
}

/**
 * Remove the account from anything that is about to be written down.
 *
 * @template T
 * @param {T} value
 * @param {Record<string, string | undefined>} [env]
 * @returns {T}
 */
export function redactCredentials(value, env = process.env) {
  const secrets = CREDENTIAL_ENV_NAMES.map((name) =>
    typeof env[name] === "string" ? env[name].trim() : "",
  ).filter((secret) => secret.length >= MIN_REDACTED_LENGTH);
  if (secrets.length === 0) return value;

  const scrub = (text) => {
    let out = text;
    for (const secret of secrets) {
      out = out.split(secret).join("[redacted]");
    }
    return out;
  };

  const walk = (node) => {
    if (typeof node === "string") return scrub(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, entry]) => [scrub(key), walk(entry)]),
      );
    }
    return node;
  };

  return walk(value);
}

/** `null` unless the value is an object, so a malformed report cannot throw. */
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * The client's own last lines. When the gate fails, this is the only place the
 * real reason (a bad login, a banned runner, a silent relay, a refill that
 * returned one exit) exists, so a failed gate quotes it instead of only the
 * verdict. The report's redaction runs over it like everything else.
 *
 * The line bound alone is not enough: the client prints pretty-printed health
 * reports, so forty lines can exceed the report parser's own field cap for a
 * long string, and one oversized `clientLog` makes the whole gate record
 * unparseable — the intake answers 400 and the report is lost. Keep the end of
 * the log, which is the part that names the last failure.
 *
 * @param {string} path
 * @param {number} [maxLines]
 * @param {number} [maxChars]
 * @returns {string | null}
 */
export function readClientLogTail(path, maxLines = 40, maxChars = MAX_CLIENT_LOG_CHARS) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = contents.split("\n").filter((line) => line.trim() !== "");
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

function text(value) {
  return typeof value === "string" ? value : null;
}

/** The lease fields a report may name, from the health report's own list. */
function readExits(health) {
  const raw = Array.isArray(health?.pool) ? health.pool : [];
  return raw
    .map(asRecord)
    .filter((exit) => exit !== null)
    .map((exit) => ({
      exitId: text(exit.exitId),
      ip: text(exit.ip),
      country: text(exit.country),
      asn: text(exit.asn),
      city: text(exit.city),
      state: text(exit.state),
    }));
}

/** An exit a Click may use: an address, a US country and a numeric ASN. */
function isUsable(exit) {
  return (
    typeof exit.ip === "string" &&
    exit.ip !== "" &&
    exit.country === "US" &&
    typeof exit.asn === "string" &&
    /^\d{1,10}$/.test(exit.asn)
  );
}

/** Every bucket the account can spend from is spent. */
function quotaSpent(buckets) {
  const list = Array.isArray(buckets) ? buckets : [];
  return list.length > 0 && list.every((bucket) => asRecord(bucket)?.remaining === 0);
}

/** The counters every verdict carries, so even a refusal says what it saw. */
function observed(health) {
  const record = asRecord(health);
  return {
    ready: typeof record?.ready === "number" ? record.ready : 0,
    exits: record === null ? [] : readExits(record),
    refills: typeof record?.refills === "number" ? record.refills : 0,
    reconnects: typeof record?.reconnects === "number" ? record.reconnects : 0,
    lastError: asRecord(record?.lastError) ?? null,
  };
}

/**
 * The verdict on one health report. `retryable` is the difference between "a
 * refill may still arrive" and "waiting changes nothing", so the wait neither
 * gives up on a filling pool nor spends three minutes on a missing credential.
 *
 * @param {unknown} health the `/health` body, or null when nothing answered
 * @returns {{ ok: boolean, reason: string | null, detail: string | null,
 *   retryable: boolean, ready: number, exits: Array<Record<string, string | null>>,
 *   refills: number, reconnects: number, lastError: Record<string, unknown> | null }}
 */
export function evaluatePoolGate(health) {
  const seen = observed(health);
  const record = asRecord(health);
  if (record === null) {
    return {
      ok: false,
      reason: "control-unreachable",
      detail: "no health report was read",
      retryable: true,
      ...seen,
    };
  }

  const usable = seen.exits.filter(isUsable);
  if (seen.exits.length > 0 && usable.length < seen.exits.length) {
    return {
      ok: false,
      reason: "no-us-exit",
      detail: `${seen.exits.length - usable.length} of ${seen.exits.length} offered exits are not a US loopback lease; a Click never substitutes one`,
      retryable: false,
      ...seen,
    };
  }

  if (usable.length >= POOL_GATE_MIN_READY) {
    return { ok: true, reason: null, detail: null, retryable: false, ...seen };
  }

  const failure = seen.lastError;
  if (failure !== null) {
    const reason = text(failure.reason) ?? "client-not-ready";
    return {
      ok: false,
      reason,
      detail: text(failure.message) ?? `the client reported ${reason}`,
      retryable: false,
      ...seen,
    };
  }
  if (record.session !== undefined && asRecord(record.session)?.state === "failed") {
    return {
      ok: false,
      reason: "client-not-ready",
      detail: "the client's session failed and no exit can arrive",
      retryable: false,
      ...seen,
    };
  }
  if (quotaSpent(record.buckets)) {
    return {
      ok: false,
      reason: "quota-spent",
      detail: "every bucket the account can spend from is spent",
      retryable: false,
      ...seen,
    };
  }

  return {
    ok: false,
    reason: "short-of-exits",
    detail: `only ${usable.length} of ${POOL_GATE_MIN_READY} exits are ready`,
    retryable: true,
    ...seen,
  };
}

async function readHealthOnce({
  controlUrl,
  fetcher,
  readTimeoutMs,
}) {
  try {
    const response = await fetcher(`${controlUrl}/health`, {
      signal: AbortSignal.timeout(readTimeoutMs),
      cache: "no-store",
    });
    if (!response.ok) {
      return { error: `the control port answered ${response.status}` };
    }
    const body = await response.json().catch(() => null);
    const health = asRecord(body);
    if (health === null) {
      return { error: "the control port returned no health report" };
    }
    return { health };
  } catch (error) {
    return {
      error: `the control port did not answer: ${firstLine(
        error instanceof Error ? error.message : String(error),
      )}`,
    };
  }
}

/**
 * Poll `/health` until the pool can serve three Clicks, or the bound expires.
 * The returned verdict is the last one seen, so a timeout names the reason it
 * kept failing rather than only that it ran out of time.
 *
 * @param {object} options
 * @param {string} options.controlUrl
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @param {number} [options.readTimeoutMs]
 * @param {typeof fetch} [options.fetcher]
 * @param {() => number} [options.now]
 * @param {(delay: number) => Promise<void>} [options.sleep]
 */
export async function waitForPoolGate({
  controlUrl,
  timeoutMs = POOL_GATE_TIMEOUT_MS,
  pollMs = POOL_GATE_POLL_MS,
  readTimeoutMs = POOL_GATE_READ_TIMEOUT_MS,
  fetcher = fetch,
  now = Date.now,
  sleep = (delay) => new Promise((done) => setTimeout(done, delay)),
}) {
  const startedAt = now();
  let attempts = 0;
  let verdict = evaluatePoolGate(null);

  for (;;) {
    attempts += 1;
    const read = await readHealthOnce({ controlUrl, fetcher, readTimeoutMs });
    verdict =
      read.health === undefined
        ? {
            ...verdict,
            ok: false,
            reason: "control-unreachable",
            detail: read.error,
            retryable: true,
          }
        : evaluatePoolGate(read.health);

    const waitedMs = now() - startedAt;
    if (verdict.ok || !verdict.retryable || waitedMs >= timeoutMs) {
      return {
        ...verdict,
        attempts,
        waitedMs,
        checkedAt: new Date(now()).toISOString(),
      };
    }
    await sleep(Math.min(pollMs, timeoutMs - waitedMs));
  }
}

/**
 * The artifact the run keeps. The gate half is the verdict a reader needs
 * first; the final half is the churn the segment saw, added after the clicks.
 *
 * @param {{ gate: Record<string, any>, minReady?: number,
 *   env?: Record<string, string | undefined> }} options
 * @returns {Record<string, any>}
 */
export function buildPoolReport({ gate, minReady = POOL_GATE_MIN_READY, env = process.env }) {
  const report = {
    enabled: true,
    minReady,
    gate: {
      ok: gate.ok === true,
      reason: typeof gate.reason === "string" ? gate.reason : null,
      detail: typeof gate.detail === "string" ? gate.detail : null,
      attempts: typeof gate.attempts === "number" ? gate.attempts : 1,
      waitedMs: typeof gate.waitedMs === "number" ? gate.waitedMs : 0,
      checkedAt: typeof gate.checkedAt === "string" ? gate.checkedAt : new Date().toISOString(),
      ready: typeof gate.ready === "number" ? gate.ready : 0,
      exits: Array.isArray(gate.exits) ? gate.exits : [],
      refills: typeof gate.refills === "number" ? gate.refills : 0,
      reconnects: typeof gate.reconnects === "number" ? gate.reconnects : 0,
      lastError: gate.lastError ?? null,
      // Present on every failed gate: the client's own log tail, which is the
      // only witness for why it never produced the exits a Click needs.
      clientLog: typeof gate.clientLog === "string" ? gate.clientLog : null,
    },
    final: null,
  };
  return redactCredentials(report, env);
}

/**
 * A failed gate quotes the client's own log tail, whatever the reason. A thin
 * pool and an unreachable port are indistinguishable from the artifact alone,
 * and the log is the only place the client's account of either exists. A gate
 * that passed pays nothing for it.
 *
 * @template {Record<string, any>} T
 * @param {T} gate
 * @param {string} [path]
 * @returns {T}
 */
export function attachClientLog(gate, path = POOL_CLIENT_LOG_PATH) {
  if (gate.ok === true) return gate;
  return { ...gate, clientLog: readClientLogTail(path) };
}

/**
 * The end-of-run half: the same pool, after the clicks, or why it could not be
 * read. A missing client is a fact about the run, not a failure of the click
 * verdict, so the caller writes it and lets the click step's exit code stand.
 *
 * @param {unknown} health
 * @param {string | null} [error]
 * @param {string} [checkedAt]
 * @returns {Record<string, any>}
 */
export function finalSnapshot(health, error = null, checkedAt = new Date().toISOString()) {
  const record = asRecord(health);
  if (record === null) {
    return {
      ok: false,
      error: error ?? "no health report was read",
      checkedAt,
      ready: null,
      exits: [],
      refills: null,
      reconnects: null,
      lastError: null,
    };
  }
  const seen = observed(record);
  return {
    ok: true,
    error: null,
    checkedAt,
    ready: seen.ready,
    exits: seen.exits,
    refills: seen.refills,
    reconnects: seen.reconnects,
    lastError: seen.lastError,
  };
}

/**
 * @param {Record<string, unknown>} report
 * @param {Record<string, any>} final
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, any>}
 */
export function mergeFinalReport(report, final, env = process.env) {
  return redactCredentials({ ...report, final }, env);
}

/** Write it, creating the directory a test or a fresh runner may not have. */
export function writePoolReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function flag(name, argv) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

function readReportPath(argv) {
  return flag("report", argv) ?? POOL_REPORT_PATH;
}

/** The client's address, or the sentence that says why there is none. */
function readControlUrl(env) {
  const parsed = parseControlUrl(env.TUXLER_CONTROL_URL ?? "");
  if (!parsed.ok) {
    return { ok: false, detail: `TUXLER_CONTROL_URL ${parsed.reason}` };
  }
  return { ok: true, url: parsed.url };
}

function readExistingReport(path) {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * After the clicks: one read, no waiting, and never a red step. The click step
 * already decided the run; this only records what the pool ended up doing.
 */
async function runFinal(argv) {
  const path = readReportPath(argv);
  const env = process.env;
  const report =
    readExistingReport(path) ??
    buildPoolReport({ gate: evaluatePoolGate(null), env });

  const control = readControlUrl(env);
  let final;
  if (!control.ok) {
    final = finalSnapshot(undefined, control.detail);
  } else {
    const read = await readHealthOnce({
      controlUrl: control.url,
      fetcher: fetch,
      readTimeoutMs: POOL_GATE_READ_TIMEOUT_MS,
    });
    final =
      read.health === undefined
        ? finalSnapshot(undefined, read.error)
        : finalSnapshot(read.health);
  }

  writePoolReport(path, mergeFinalReport(report, final, env));
  console.log(
    `browser-pool-gate: final ${final.ok ? `${final.ready} ready exit(s)` : `unavailable (${final.error})`}`,
  );
  return 0;
}

async function main(argv) {
  const env = process.env;
  if (argv.includes("--final")) return runFinal(argv);

  const flagValue = readFlag(env);
  if (flagValue !== "true") {
    console.error(
      `browser-pool-gate: TUXLER_ENABLED must be "true" to gate a pooled run, got ` +
        `${flagValue === "unknown" ? JSON.stringify(env.TUXLER_ENABLED) : "off"}; ` +
        "the workflow skips this step, so a manual run must not pass it",
    );
    return 2;
  }

  const path = readReportPath(argv);
  const control = readControlUrl(env);
  if (!control.ok) {
    // Nothing was asked, so nothing is waited for: a wrong address is a
    // configuration mistake, and no Click may follow it either way.
    writePoolReport(
      path,
      buildPoolReport({
        gate: { ...evaluatePoolGate(null), reason: "bad-control-url", detail: control.detail },
        env,
      }),
    );
    console.error(`browser-pool-gate: FAILED ${control.detail}; no Click will run`);
    return 1;
  }

  // Every failed gate carries the client's own log tail: the reason the port
  // never opened, or the one it opened and then ran short of exits on.
  const gate = attachClientLog(await waitForPoolGate({ controlUrl: control.url }));
  const report = buildPoolReport({ gate, env });
  writePoolReport(path, report);

  if (gate.ok) {
    console.log(
      `browser-pool-gate: ${gate.ready} ready exit(s) after ${gate.waitedMs} ms, ` +
        `${report.gate.refills} refill(s); the segment may click`,
    );
    return 0;
  }
  console.error(
    `browser-pool-gate: FAILED ${report.gate.reason} after ${report.gate.waitedMs} ms: ` +
      `${report.gate.detail}; no Click will run`,
  );
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        `browser-pool-gate: ${firstLine(error instanceof Error ? error.message : String(error))}`,
      );
      process.exitCode = 1;
    });
}
