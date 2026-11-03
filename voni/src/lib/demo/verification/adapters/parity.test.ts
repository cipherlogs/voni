/**
 * Parity is a verdict-level contract: the two adapters may differ in speed and
 * never in permissiveness. These tests pin both directions of disagreement and
 * the exclusion that makes the rule honest (timing is not compared).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  compareAdapterVerdicts,
  parityLine,
  snapshotVerdict,
  type AdapterPropertySnapshot,
  type AdapterVerdictSnapshot,
} from "./parity";
import type { RunVerdict } from "../verdict";

function verdict(properties: readonly AdapterPropertySnapshot[]): RunVerdict {
  return {
    runId: "run-parity",
    verdict: "not-demo-ready",
    certifiable: false,
    eligible: true,
    eligibility: { eligible: true, reasons: [], callCount: 1 },
    properties: properties.map((property) => ({
      propertyId: property.propertyId,
      family: "conduct",
      statement: property.propertyId,
      bar: "probe",
      barNumeric: false,
      kind: property.kind as "deterministic",
      evidence: "ledger",
      status: property.status,
      reason: property.reason,
      detail: "",
      sampleCount: 1,
      requiredRepetitions: 1,
      smallSample: false,
      summary: null,
      scenarios: [],
      checks: [],
      citations: [],
      gaps: [],
    })),
    failedPropertyIds: properties
      .filter((property) => property.status === "FAIL")
      .map((property) => property.propertyId),
    unknownPropertyIds: [],
    failures: [],
    sampleCount: properties.length,
    citations: [],
    detail: "",
  };
}

function snapshot(
  adapter: "browser" | "protocol",
  properties: readonly AdapterPropertySnapshot[],
): AdapterVerdictSnapshot {
  return snapshotVerdict(adapter, verdict(properties), "golden-flow");
}

const PASS: AdapterPropertySnapshot = {
  propertyId: "L1",
  kind: "deterministic",
  status: "PASS",
  reason: "pass",
};
const FAIL: AdapterPropertySnapshot = {
  propertyId: "L1",
  kind: "deterministic",
  status: "FAIL",
  reason: "below-bar",
};

test("both adapters agreeing on every deterministic property is parity", () => {
  const report = compareAdapterVerdicts(snapshot("browser", [PASS]), snapshot("protocol", [PASS]));
  assert.equal(report.agree, true);
  assert.deepEqual(report.comparedPropertyIds, ["L1"]);
  assert.deepEqual(report.disagreements, []);
  assert.match(parityLine(report), /1 deterministic property agree/);
});

test("the protocol adapter passing what the browser failed is named, never accepted", () => {
  const report = compareAdapterVerdicts(snapshot("browser", [FAIL]), snapshot("protocol", [PASS]));
  assert.equal(report.agree, false);
  assert.equal(report.disagreements.length, 1);
  assert.equal(report.disagreements[0]?.kind, "protocol-more-permissive");
  assert.equal(report.disagreements[0]?.propertyId, "L1");
  assert.match(report.disagreements[0]?.detail ?? "", /L1: browser FAIL \(below-bar\) but protocol PASS/);
  assert.match(parityLine(report), /L1/);
});

test("the protocol adapter failing what the browser passed is also a disagreement", () => {
  const report = compareAdapterVerdicts(snapshot("browser", [PASS]), snapshot("protocol", [FAIL]));
  assert.equal(report.agree, false);
  assert.equal(report.disagreements[0]?.kind, "protocol-less-permissive");
});

test("the same status with a different reason is a disagreement", () => {
  const report = compareAdapterVerdicts(
    snapshot("browser", [PASS]),
    snapshot("protocol", [{ ...PASS, reason: "unmeasured" }]),
  );
  assert.equal(report.agree, false);
  assert.equal(report.disagreements[0]?.kind, "status-disagreement");
  assert.match(report.disagreements[0]?.detail ?? "", /unmeasured/);
});

test("timing and behaviour properties are not compared, and the exclusion is named", () => {
  const timing: AdapterPropertySnapshot = {
    propertyId: "T1",
    kind: "timing",
    status: "PASS",
    reason: "pass",
  };
  const report = compareAdapterVerdicts(
    snapshot("browser", [PASS, timing]),
    snapshot("protocol", [PASS, { ...timing, status: "FAIL", reason: "below-bar" }]),
  );
  assert.equal(report.agree, true, "the protocol adapter may be faster");
  assert.deepEqual(report.comparedPropertyIds, ["L1"]);
  assert.equal(report.notCompared.length, 1);
  assert.match(report.notCompared[0] ?? "", /T1 \(timing\) is not compared/);
});

test("a property one adapter did not report is a disagreement, not silence", () => {
  const report = compareAdapterVerdicts(
    snapshot("browser", [PASS]),
    snapshot("protocol", [
      PASS,
      { propertyId: "L2", kind: "deterministic", status: "PASS", reason: "pass" },
    ]),
  );
  assert.equal(report.agree, false);
  assert.deepEqual(
    report.disagreements.map((item) => [item.kind, item.propertyId]),
    [["property-missing", "L2"]],
  );
});

test("two different scenarios cannot be compared", () => {
  const browser = snapshot("browser", [PASS]);
  const protocol = snapshotVerdict("protocol", verdict([PASS]), "other-scenario");
  const report = compareAdapterVerdicts(browser, protocol);
  assert.equal(report.agree, false);
  assert.equal(report.disagreements[0]?.kind, "scenario-mismatch");
});
