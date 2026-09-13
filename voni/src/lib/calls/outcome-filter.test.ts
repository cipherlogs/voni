import assert from "node:assert/strict";
import test from "node:test";
import { calls, leads } from "../db/schema.js";
import {
  callConnected,
  latestBlockersNonEmpty,
  liveAppointmentExists,
} from "../outcomes/predicates.js";
import { callOutcomeCondition } from "./outcome-filter.js";

/**
 * Interpolated identifiers stringify as placeholders under String(sql), so
 * assertions read the literal query chunks instead — the FROM/JOIN/table
 * names live there while bound values stay parameterized.
 */
function fragmentText(fragment: unknown): string {
  const chunks =
    (
      fragment as {
        queryChunks?: Array<{ value?: unknown }>;
      }
    ).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (Array.isArray(chunk.value)) return chunk.value.join("");
      return typeof chunk.value === "string" ? chunk.value : "";
    })
    .join(" ");
}

function normalizeSql(fragment: unknown): string {
  return fragmentText(fragment).replace(/\s+/g, " ").trim();
}

test("call outcome conditions normalize to the shared predicates", () => {
  assert.equal(
    normalizeSql(callOutcomeCondition("connected")),
    normalizeSql(callConnected()),
    "connected is the shared ended-call predicate",
  );
  assert.equal(
    normalizeSql(callOutcomeCondition("booked")),
    normalizeSql(liveAppointmentExists(calls.leadId)),
    "booked is the shared live-appointment predicate",
  );
  assert.equal(
    normalizeSql(callOutcomeCondition("handoff")),
    normalizeSql(latestBlockersNonEmpty(calls.leadId)),
    "handoff is the shared latest-blockers predicate",
  );
});

test("call grain and lead grain normalize to the same predicate text", () => {
  // The lead column binds as a parameter, so call grain (calls.leadId) and
  // lead grain (leads.id) produce identical SQL text — the predicates differ
  // only in the bound value.
  assert.equal(
    normalizeSql(liveAppointmentExists(calls.leadId)),
    normalizeSql(liveAppointmentExists(leads.id)),
    "booked text is grain-independent",
  );
  assert.equal(
    normalizeSql(latestBlockersNonEmpty(calls.leadId)),
    normalizeSql(latestBlockersNonEmpty(leads.id)),
    "handoff text is grain-independent",
  );
});

test("handoff predicate covers the NULL/empty-blockers edges", () => {
  const handoff = normalizeSql(callOutcomeCondition("handoff"));
  // NULL (no conversation_states row) yields NULL from `<>`, which WHERE
  // drops — never a handoff. '[]' (state row, empty blocker list) yields
  // false — never a handoff. Only a non-empty blocker array yields true.
  assert.ok(handoff.includes("<> '[]'"), "only non-empty blockers match");
  assert.ok(
    handoff.includes("order by created_at desc limit 1"),
    "latest state row only",
  );
});
