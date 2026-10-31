/**
 * Rollback is one routing value: `off`.
 *
 * It flips future calls to the durable routing switch's `off` mode; it is not
 * a deploy and it creates no second engine. The existing kill-switch proof
 * (`npm run cutover:check -- --prove-off`) is the evidence: a valid v2 demo
 * body is refused with `code: "managed"` and leaves no greeting, turn, or
 * vendor leg behind. This module records that proof and refuses a record that
 * claims a new vendor session or a different routing value.
 */

import { ReleaseError } from "./errors";

export const ROLLBACK_ROUTING_MODE = "off" as const;

/** The one value an operator flips; a CLI prints it and nothing else. */
export function rollbackRoutingValue(): typeof ROLLBACK_ROUTING_MODE {
  return ROLLBACK_ROUTING_MODE;
}

export type RollbackRecord = {
  readonly schemaVersion: 1;
  readonly mode: typeof ROLLBACK_ROUTING_MODE;
  readonly at: string;
  readonly operator: string;
  /** The refused call the proof opened after the flip. */
  readonly callId: string;
  /** The service's refusal code; the only accepted value is `managed`. */
  readonly refusedCode: string;
  /** New vendor sessions the refused call produced; the bar is zero. */
  readonly newVendorSessions: number;
};

export type RollbackEvaluation = {
  readonly ok: boolean;
  readonly exitCode: 0 | 2;
  readonly value: typeof ROLLBACK_ROUTING_MODE;
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly code: string;
    readonly detail: string;
  }[];
  readonly detail: string;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReleaseError("invalid-record", "a rollback record is an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleaseError("invalid-record", `rollback record ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Parse a kill-switch proof record. A different routing mode is refused: a
 * rollback is one value, not a menu. A non-zero vendor session count is refused
 * by name, because a rollback that still opens a vendor is not a rollback.
 */
export function parseRollbackRecord(raw: unknown): RollbackRecord {
  const entry = record(raw);
  if (entry.schemaVersion !== 1) {
    throw new ReleaseError(
      "invalid-record",
      `rollback record schema version ${String(entry.schemaVersion)} is not 1`,
    );
  }
  if (entry.mode !== ROLLBACK_ROUTING_MODE) {
    throw new ReleaseError(
      "wrong-mode",
      `rollback mode is "${String(entry.mode)}"; rollback is one routing value: "off"`,
    );
  }
  const at = text(entry.at, "at");
  if (Number.isNaN(Date.parse(at))) {
    throw new ReleaseError("invalid-record", `rollback record at "${at}" is not a date`);
  }
  const newVendorSessions = entry.newVendorSessions;
  if (typeof newVendorSessions !== "number" || !Number.isInteger(newVendorSessions) || newVendorSessions < 0) {
    throw new ReleaseError(
      "invalid-record",
      `rollback record newVendorSessions is ${String(newVendorSessions)}; it must be a whole number`,
    );
  }
  if (newVendorSessions !== 0) {
    throw new ReleaseError(
      "vendor-sessions",
      `rollback record claims ${newVendorSessions} new vendor session(s); a rollback produces zero`,
    );
  }
  return {
    schemaVersion: 1,
    mode: ROLLBACK_ROUTING_MODE,
    at,
    operator: text(entry.operator, "operator"),
    callId: text(entry.callId, "callId"),
    refusedCode: text(entry.refusedCode, "refusedCode"),
    newVendorSessions,
  };
}

/** Judge a rollback record; absent proof is missing evidence, never assumed. */
export function evaluateRollback(record: RollbackRecord | null): RollbackEvaluation {
  if (record === null) {
    return {
      ok: false,
      exitCode: 2,
      value: ROLLBACK_ROUTING_MODE,
      checks: [
        {
          name: "kill-switch-proof",
          ok: false,
          code: "missing-proof",
          detail:
            "no kill-switch proof record: run `npm run cutover:check -- --prove-off` and record " +
            "the refused call it observed",
        },
      ],
      detail:
        "missing-evidence: the rollback is one value (off), but no kill-switch proof record " +
        "shows zero new vendor sessions",
    };
  }
  const checks: RollbackEvaluation["checks"] = [
    {
      name: "routing",
      ok: record.mode === ROLLBACK_ROUTING_MODE,
      code: "one-routing-value",
      detail: `rollback value is "${record.mode}"`,
    },
    {
      name: "refusal",
      ok: record.refusedCode === "managed",
      code: record.refusedCode === "managed" ? "managed" : "unexpected-refusal",
      detail: `the post-flip call was refused with code "${record.refusedCode}"`,
    },
    {
      name: "vendor-sessions",
      ok: record.newVendorSessions === 0,
      code: record.newVendorSessions === 0 ? "zero-vendor-sessions" : "vendor-session",
      detail: `the refused call opened ${record.newVendorSessions} new vendor session(s)`,
    },
  ];
  const ok = checks.every((entry) => entry.ok);
  return {
    ok,
    exitCode: ok ? 0 : 2,
    value: ROLLBACK_ROUTING_MODE,
    checks,
    detail: ok
      ? `rollback is "${ROLLBACK_ROUTING_MODE}": call ${record.callId} refused with "managed" and ` +
        "zero new vendor sessions"
      : `blocked: ${checks
          .filter((entry) => !entry.ok)
          .map((entry) => `${entry.code}: ${entry.detail}`)
          .join("; ")}`,
  };
}
