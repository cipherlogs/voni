/**
 * The monthly full production certification: scheduled, and recorded as a
 * committed entry that points at a production certificate.
 *
 * The schedule lives here as one constant; the scheduled workflow must carry
 * exactly this cron (its workflow-as-code test compares the two). The record is
 * `voni/evidence/cutover/monthly-production.json`; an empty record is
 * `pending-human` (exit 3), never a green — production has no evidence sink yet,
 * so the month is scheduled but not certified. A stale entry is overdue
 * (exit 1); a cron drift or an entry that points at another target, image or
 * fingerprint is missing evidence (exit 2).
 *
 * RR-05: the monthly full production certification bounds how long a stale
 * green can stand.
 */

import type { CodeFingerprint } from "../../scoreboard";
import type { Certificate } from "../certificate";
import { isCleanCertification } from "./streak";
import { ReleaseError } from "./errors";

/** The one schedule; the monthly workflow must carry this exact cron. */
export const MONTHLY_PRODUCTION_CRON = "0 4 1 * *";

export const MONTHLY_RECORD_VERSION = 1;

export type MonthlyProductionEntry = {
  /** `YYYY-MM`, the month the certification is the monthly proof for. */
  readonly month: string;
  readonly runId: string;
  readonly image: string;
  readonly fingerprint: CodeFingerprint;
  readonly certifiedAt: string;
};

export type MonthlyProductionRecord = {
  readonly version: typeof MONTHLY_RECORD_VERSION;
  readonly cron: string;
  /** An IANA zone; the cron is read in it, never in a server's local time. */
  readonly timezone: string;
  readonly entries: readonly MonthlyProductionEntry[];
};

export type MonthlyEvaluation = {
  readonly ok: boolean;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly status: "current" | "overdue" | "missing-evidence" | "pending-human";
  readonly runId: string | null;
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly code: string;
    readonly detail: string;
  }[];
  readonly detail: string;
};

const MONTH = /^\d{4}-\d{2}$/;

/** The committed record's empty starting point: scheduled, no certification. */
export function monthlyProductionRecord(): MonthlyProductionRecord {
  return {
    version: MONTHLY_RECORD_VERSION,
    cron: MONTHLY_PRODUCTION_CRON,
    timezone: "UTC",
    entries: [],
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReleaseError("invalid-record", "the monthly production record is an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleaseError(
      "invalid-record",
      `monthly production record ${field} must be a non-empty string`,
    );
  }
  return value;
}

function entry(value: unknown, index: number): MonthlyProductionEntry {
  const raw = record(value);
  const fingerprint = record(raw.fingerprint);
  const month = text(raw.month, `entries[${index}].month`);
  if (!MONTH.test(month) || Number.isNaN(Date.parse(`${month}-01`))) {
    throw new ReleaseError(
      "invalid-record",
      `monthly production entries[${index}].month "${month}" is not YYYY-MM`,
    );
  }
  const certifiedAt = text(raw.certifiedAt, `entries[${index}].certifiedAt`);
  if (Number.isNaN(Date.parse(certifiedAt))) {
    throw new ReleaseError(
      "invalid-record",
      `monthly production entries[${index}].certifiedAt "${certifiedAt}" is not a date`,
    );
  }
  return {
    month,
    runId: text(raw.runId, `entries[${index}].runId`),
    image: text(raw.image, `entries[${index}].image`),
    fingerprint: {
      head: text(fingerprint.head, `entries[${index}].fingerprint.head`),
      dirty: fingerprint.dirty === true,
      dirtyHash: text(fingerprint.dirtyHash, `entries[${index}].fingerprint.dirtyHash`),
    },
    certifiedAt,
  };
}

/** Read a committed monthly record; an unknown shape is refused by name. */
export function parseMonthlyProductionRecord(raw: unknown): MonthlyProductionRecord {
  const root = record(raw);
  if (root.version !== MONTHLY_RECORD_VERSION) {
    throw new ReleaseError(
      "invalid-record",
      `monthly production record version ${String(root.version)} is not ${MONTHLY_RECORD_VERSION}`,
    );
  }
  if (!Array.isArray(root.entries)) {
    throw new ReleaseError("invalid-record", "monthly production record entries is not an array");
  }
  return {
    version: MONTHLY_RECORD_VERSION,
    cron: text(root.cron, "cron"),
    timezone: text(root.timezone, "timezone"),
    entries: root.entries.map(entry),
  };
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function previousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 2, 1));
  return monthOf(date);
}

function newestEntry(entries: readonly MonthlyProductionEntry[]): MonthlyProductionEntry | null {
  if (entries.length === 0) return null;
  return [...entries].sort((left, right) =>
    left.month < right.month ? -1 : left.month > right.month ? 1 : 0,
  )[entries.length - 1];
}

/** Judge the recorded monthly production proof for the month containing `now`. */
export function evaluateMonthlyProduction(input: {
  readonly record: MonthlyProductionRecord;
  readonly certificates: readonly Certificate[];
  readonly now: Date;
  /** The deployed image the month is meant to cover; optional. */
  readonly image?: string;
}): MonthlyEvaluation {
  const checks: { name: string; ok: boolean; code: string; detail: string }[] = [];
  const add = (name: string, ok: boolean, code: string, detail: string): void => {
    checks.push({ name, ok, code, detail });
  };

  add(
    "schedule",
    input.record.cron === MONTHLY_PRODUCTION_CRON,
    input.record.cron === MONTHLY_PRODUCTION_CRON ? "scheduled" : "cron-drift",
    input.record.cron === MONTHLY_PRODUCTION_CRON
      ? `monthly full production is scheduled "${MONTHLY_PRODUCTION_CRON}" (${input.record.timezone})`
      : `the record's cron "${input.record.cron}" differs from the one schedule ` +
        `"${MONTHLY_PRODUCTION_CRON}"`,
  );
  if (input.record.cron !== MONTHLY_PRODUCTION_CRON) {
    return {
      ok: false,
      exitCode: 2,
      status: "missing-evidence",
      runId: null,
      checks,
      detail:
        `missing-evidence: the monthly record's cron "${input.record.cron}" is not the one ` +
        `schedule "${MONTHLY_PRODUCTION_CRON}"`,
    };
  }

  const latest = newestEntry(input.record.entries);
  if (latest === null) {
    return {
      ok: false,
      exitCode: 3,
      status: "pending-human",
      runId: null,
      checks,
      detail:
        `pending-human: monthly full production is scheduled (${MONTHLY_PRODUCTION_CRON}) but no ` +
        "certification is recorded; production has no evidence sink and the owner's panel is a " +
        "human gate (ticket 25/27)",
    };
  }

  const certificate = input.certificates.find((entry) => entry.runId === latest.runId) ?? null;
  add(
    "certificate",
    certificate !== null,
    certificate === null ? "missing-certificate" : "recorded-certificate",
    certificate === null
      ? `monthly entry ${latest.month} names run ${latest.runId}, which has no committed certificate`
      : `monthly entry ${latest.month} cites ${latest.runId}`,
  );
  if (certificate === null) {
    return {
      ok: false,
      exitCode: 3,
      status: "pending-human",
      runId: latest.runId,
      checks,
      detail:
        `pending-human: the ${latest.month} monthly production certification ${latest.runId} is ` +
        "recorded but has no committed certificate",
    };
  }

  const production = certificate.target === "production" && certificate.plan.mode === "full";
  add(
    "production-full",
    production,
    production ? "production-full" : "wrong-target-or-plan",
    production
      ? `certificate ${certificate.runId} is a full production certification`
      : `certificate ${certificate.runId} is target "${certificate.target}" plan ` +
        `"${certificate.plan.mode}", not a full production certification`,
  );
  const sameImage = latest.image === certificate.code.pipelineImage &&
    (input.image === undefined || input.image === latest.image);
  add(
    "image",
    sameImage,
    sameImage ? "same-image" : "image-mismatch",
    sameImage
      ? `monthly entry covers image ${latest.image}`
      : `monthly entry covers image ${latest.image}, certificate ${certificate.code.pipelineImage}` +
        `${input.image === undefined ? "" : `, deployed ${input.image}`}`,
  );
  const sameFingerprint =
    latest.fingerprint.head === certificate.code.fingerprint.head &&
    latest.fingerprint.dirtyHash === certificate.code.fingerprint.dirtyHash;
  add(
    "fingerprint",
    sameFingerprint,
    sameFingerprint ? "same-fingerprint" : "code-fingerprint-mismatch",
    sameFingerprint
      ? `monthly entry ran code ${latest.fingerprint.head}`
      : `monthly entry ran code ${latest.fingerprint.head}, certificate ` +
        certificate.code.fingerprint.head,
  );
  const clean = isCleanCertification(certificate);
  add(
    "clean",
    clean,
    clean ? "clean" : "not-clean",
    clean
      ? `certificate ${certificate.runId} is certified, covered and signed`
      : `certificate ${certificate.runId} is ${certificate.verdict} and cannot carry the month`,
  );

  const currentMonth = monthOf(input.now);
  const allowed = new Set([currentMonth, previousMonth(currentMonth)]);
  const current = allowed.has(latest.month);
  add(
    "cadence",
    current,
    current ? "current" : "overdue",
    current
      ? `the ${latest.month} certification is current for ${currentMonth}`
      : `the ${latest.month} certification is overdue for ${currentMonth}; a monthly full production ` +
        "certification is the backstop (RR-05)",
  );

  const failed = checks.filter((entry) => !entry.ok);
  const missing = failed.filter((entry) => entry.code !== "overdue");
  const exitCode: MonthlyEvaluation["exitCode"] =
    failed.length === 0 ? 0 : missing.length > 0 ? 2 : 1;
  const status: MonthlyEvaluation["status"] =
    failed.length === 0 ? "current" : missing.length > 0 ? "missing-evidence" : "overdue";
  const detail =
    failed.length === 0
      ? `current: monthly full production certification ${latest.runId} covers ${latest.month} ` +
        `on image ${latest.image}`
      : `${status}: ` + failed.map((entry) => `${entry.code}: ${entry.detail}`).join("; ");
  return { ok: failed.length === 0, exitCode, status, runId: latest.runId, checks, detail };
}
