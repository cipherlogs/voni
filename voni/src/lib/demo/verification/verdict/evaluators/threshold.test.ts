import test from "node:test";
import assert from "node:assert/strict";

import type { ContractPropertyEntry } from "../../contract";
import { threshold } from "./threshold";

function property(thresholds: ContractPropertyEntry["thresholds"]): ContractPropertyEntry {
  return {
    id: "L8",
    family: "lifecycle",
    statement: "probe",
    bar: "probe",
    barNumeric: true,
    kind: "deterministic",
    evidence: "browser",
    thresholds,
  } as unknown as ContractPropertyEntry;
}

const context = (thresholds: ContractPropertyEntry["thresholds"]) => ({ property: property(thresholds) });

test("threshold resolves the one frozen number a bar names", () => {
  const value = threshold(context([{ key: "dvClockStartBeforeAudioMaxCount", value: 0 }] as never), "dvClockStartBeforeAudioMaxCount");
  assert.equal(value, 0);
});

test("a missing or non-numeric threshold throws by name, never a default", () => {
  assert.throws(
    () => threshold(context([]), "dvClockStartBeforeAudioMaxCount"),
    /dvClockStartBeforeAudioMaxCount/,
  );
  assert.throws(
    () => threshold(context([{ key: "dvClockStartBeforeAudioMaxCount", value: Number.NaN }] as never), "dvClockStartBeforeAudioMaxCount"),
    /dvClockStartBeforeAudioMaxCount/,
  );
});
