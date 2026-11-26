/**
 * The exit-pool report a GitHub runner pushes to the app.
 *
 * The pool client listens on the runner's own loopback, so the `/email` card
 * could never read it: the address dies with the job. The workflow therefore
 * POSTs the artifact `scripts/browser-pool-gate.mjs` writes, and this module is
 * the one place its shape is parsed, stored and read back.
 *
 * The shape here mirrors `buildPoolReport`/`finalSnapshot` exactly — the gate
 * half a run starts with, and the final snapshot added after the clicks. The
 * parser returns a canonical object (known keys only) so the jsonb column
 * cannot accumulate caller-chosen fields, and it never throws: a malformed body
 * is a short machine-readable reason, because the caller is a machine and the
 * body can quote a log.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tuxlerPoolReports } from "@/lib/db/schema";
import { RUNNER_OS_VALUES, type RunnerOs } from "@/lib/email/click-report";

/** The only producer that pushes a pool report today. */
export const POOL_REPORT_PRODUCER = "github" as const;
export type PoolReportProducer = typeof POOL_REPORT_PRODUCER;

/** One exit lease as the report records it; every field is an observation. */
export type TuxlerPoolExit = {
  exitId: string | null;
  ip: string | null;
  country: string | null;
  asn: string | null;
  city: string | null;
  state: string | null;
};

/** The gate half: what the pool looked like before any click. */
export type TuxlerPoolGate = {
  ok: boolean;
  reason: string | null;
  detail: string | null;
  attempts: number;
  waitedMs: number;
  checkedAt: string;
  ready: number;
  exits: TuxlerPoolExit[];
  refills: number;
  reconnects: number;
  lastError: Record<string, unknown> | null;
  clientLog: string | null;
};

/** The end-of-run half; `ok: false` leaves the counts null, as the script does. */
export type TuxlerPoolFinal = {
  ok: boolean;
  error: string | null;
  checkedAt: string;
  ready: number | null;
  exits: TuxlerPoolExit[];
  refills: number | null;
  reconnects: number | null;
  lastError: Record<string, unknown> | null;
};

/** The whole artifact, `enabled` true and `final` null or filled in. */
export type TuxlerPoolReport = {
  enabled: boolean;
  minReady: number;
  gate: TuxlerPoolGate;
  final: TuxlerPoolFinal | null;
};

export type PoolReportParse =
  | { ok: true; value: TuxlerPoolReport }
  | { ok: false; reason: string };

export type PoolReportInput = {
  producer: PoolReportProducer;
  runnerOs: RunnerOs;
  report: TuxlerPoolReport;
};

/** What the console renders: the newest report, and when it arrived. */
export type LatestPoolReport = {
  runnerOs: RunnerOs;
  receivedAt: Date;
  report: TuxlerPoolReport;
};

/** Bounds that keep one report a report, not a log dump. */
const MAX_LISTED_EXITS = 64;
const MAX_SHORT_TEXT = 400;
const MAX_LONG_TEXT = 16_000;
const MAX_COUNT = 1_000_000_000;

type Json = Record<string, unknown>;

function asRecord(raw: unknown): Json | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Json)
    : null;
}

function isCount(raw: unknown): raw is number {
  return (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= MAX_COUNT
  );
}

function isNullableCount(raw: unknown): raw is number | null {
  return raw === null || isCount(raw);
}

/**
 * `undefined` is accepted only where the producer always writes the key: the
 * script emits every nullable field, so an absent one is treated as null rather
 * than becoming a second way to say "not observed".
 */
function shortText(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_SHORT_TEXT) return undefined;
  return trimmed;
}

function longText(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  if (raw.length > MAX_LONG_TEXT) return undefined;
  return raw;
}

/**
 * An exit's field, where absence is malformed rather than "not observed": the
 * script writes all six keys, so a missing one is a different producer and the
 * card would read it as an exit with no address.
 */
function observedText(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_SHORT_TEXT) return undefined;
  return trimmed;
}

function checkedAt(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > MAX_SHORT_TEXT) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return raw;
}

function lastError(raw: unknown): Record<string, unknown> | null | undefined {
  if (raw === undefined || raw === null) return null;
  return asRecord(raw) ?? undefined;
}

function parseExit(raw: unknown): TuxlerPoolExit | undefined {
  const exit = asRecord(raw);
  if (exit === null) return undefined;
  const exitId = observedText(exit["exitId"]);
  const ip = observedText(exit["ip"]);
  const country = observedText(exit["country"]);
  const asn = observedText(exit["asn"]);
  const city = observedText(exit["city"]);
  const state = observedText(exit["state"]);
  if (
    exitId === undefined ||
    ip === undefined ||
    country === undefined ||
    asn === undefined ||
    city === undefined ||
    state === undefined
  ) {
    return undefined;
  }
  return { exitId, ip, country, asn, city, state };
}

function parseExits(raw: unknown): TuxlerPoolExit[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_LISTED_EXITS) return undefined;
  const exits: TuxlerPoolExit[] = [];
  for (const entry of raw) {
    const exit = parseExit(entry);
    if (exit === undefined) return undefined;
    exits.push(exit);
  }
  return exits;
}

function parseGate(raw: unknown): TuxlerPoolGate | undefined {
  const gate = asRecord(raw);
  if (gate === null) return undefined;
  if (typeof gate["ok"] !== "boolean") return undefined;

  const reason = shortText(gate["reason"]);
  const detail = longText(gate["detail"]);
  const clientLog = longText(gate["clientLog"]);
  if (reason === undefined || detail === undefined || clientLog === undefined) {
    return undefined;
  }

  const at = checkedAt(gate["checkedAt"]);
  if (at === undefined) return undefined;

  if (
    !isCount(gate["attempts"]) ||
    !isCount(gate["waitedMs"]) ||
    !isCount(gate["ready"]) ||
    !isCount(gate["refills"]) ||
    !isCount(gate["reconnects"])
  ) {
    return undefined;
  }

  const exits = parseExits(gate["exits"]);
  if (exits === undefined) return undefined;

  const error = lastError(gate["lastError"]);
  if (error === undefined) return undefined;

  return {
    ok: gate["ok"],
    reason,
    detail,
    attempts: gate["attempts"],
    waitedMs: gate["waitedMs"],
    checkedAt: at,
    ready: gate["ready"],
    exits,
    refills: gate["refills"],
    reconnects: gate["reconnects"],
    lastError: error,
    clientLog,
  };
}

function parseFinal(raw: unknown): TuxlerPoolFinal | null | undefined {
  // The script always writes the key, but its first write is `final: null`;
  // an absent key means the same thing rather than a second malformed case.
  if (raw === undefined || raw === null) return null;
  const final = asRecord(raw);
  if (final === null) return undefined;
  if (typeof final["ok"] !== "boolean") return undefined;

  const error = shortText(final["error"]);
  if (error === undefined) return undefined;

  const at = checkedAt(final["checkedAt"]);
  if (at === undefined) return undefined;

  if (!isNullableCount(final["ready"])) return undefined;
  if (!isNullableCount(final["refills"])) return undefined;
  if (!isNullableCount(final["reconnects"])) return undefined;

  const exits = parseExits(final["exits"]);
  if (exits === undefined) return undefined;

  const lastErrorValue = lastError(final["lastError"]);
  if (lastErrorValue === undefined) return undefined;

  return {
    ok: final["ok"],
    error,
    checkedAt: at,
    ready: final["ready"],
    exits,
    refills: final["refills"],
    reconnects: final["reconnects"],
    lastError: lastErrorValue,
  };
}

/**
 * Parse one report exactly as `browser-pool-gate.mjs` writes it. Unknown keys
 * are dropped rather than refused: the script may grow a field before this
 * module knows about it, and the stored report must stay the shape the console
 * reads. Reasons are fixed strings, never the offending value.
 */
export function parsePoolReport(raw: unknown): PoolReportParse {
  const body = asRecord(raw);
  if (body === null) return { ok: false, reason: "not_object" };

  if (body["enabled"] !== true) return { ok: false, reason: "not_enabled" };

  if (!isCount(body["minReady"]) || body["minReady"] === 0) {
    return { ok: false, reason: "bad_min_ready" };
  }

  const gate = parseGate(body["gate"]);
  if (gate === undefined) return { ok: false, reason: "bad_gate" };

  const final = parseFinal(body["final"]);
  if (final === undefined) return { ok: false, reason: "bad_final" };

  return {
    ok: true,
    value: { enabled: true, minReady: body["minReady"], gate, final },
  };
}

/**
 * The OS a report came from, from the header the workflow sends. Accepts only
 * the names the click intake already stores, so a per-OS row always matches a
 * `runner_os` value elsewhere in the console; unknown or absent is null and the
 * route answers 400 with the reason.
 */
export function parsePoolReportRunnerOs(raw: string | null | undefined): RunnerOs | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return (RUNNER_OS_VALUES as readonly string[]).includes(normalized)
    ? (normalized as RunnerOs)
    : null;
}

/**
 * The upsert the intake performs: one row per `(producer, runner_os)`, with the
 * report and its arrival time replaced together. Exported as a query so a test
 * can prove the conflict target and the replaced columns without a database.
 */
export function poolReportUpsert(input: PoolReportInput, receivedAt = new Date()) {
  return db
    .insert(tuxlerPoolReports)
    .values({
      producer: input.producer,
      runnerOs: input.runnerOs,
      receivedAt,
      report: input.report,
    })
    .onConflictDoUpdate({
      target: [tuxlerPoolReports.producer, tuxlerPoolReports.runnerOs],
      set: { receivedAt, report: input.report },
    });
}

/**
 * The newest report, optionally narrowed to one OS. Newest is `received_at`
 * descending, not insert order: the upsert rewrites that column on every push,
 * so a row's position never depends on which OS first created it.
 */
export function latestPoolReportQuery(runnerOs?: RunnerOs) {
  const producer = eq(tuxlerPoolReports.producer, POOL_REPORT_PRODUCER);
  return db
    .select({
      runnerOs: tuxlerPoolReports.runnerOs,
      receivedAt: tuxlerPoolReports.receivedAt,
      report: tuxlerPoolReports.report,
    })
    .from(tuxlerPoolReports)
    .where(
      runnerOs === undefined
        ? producer
        : and(producer, eq(tuxlerPoolReports.runnerOs, runnerOs)),
    )
    .orderBy(desc(tuxlerPoolReports.receivedAt))
    .limit(1);
}

/** The production store, as one object so tests can substitute one. */
export type PoolReportStore = {
  upsert(input: PoolReportInput): Promise<void>;
  latest(runnerOs?: RunnerOs): Promise<LatestPoolReport | null>;
};

export const databasePoolReportStore: PoolReportStore = {
  async upsert(input) {
    await poolReportUpsert(input);
  },
  async latest(runnerOs) {
    const rows = await latestPoolReportQuery(runnerOs);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      runnerOs: row.runnerOs,
      receivedAt: row.receivedAt,
      report: row.report,
    };
  },
};

/** Write the validated report, replacing the previous one for that OS. */
export function storePoolReport(
  input: PoolReportInput,
  store: PoolReportStore = databasePoolReportStore,
): Promise<void> {
  return store.upsert(input);
}

/**
 * The last known pool, newest first, for the console. An absent `runnerOs`
 * answers the newest row across every OS.
 */
export function readLatestPoolReport(
  runnerOs?: RunnerOs,
  store: PoolReportStore = databasePoolReportStore,
): Promise<LatestPoolReport | null> {
  return store.latest(runnerOs);
}
