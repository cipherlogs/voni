import test from "node:test";
import assert from "node:assert/strict";
import { isAgentStale } from "./platform-refresh";
import { REAL_ESTATE_TEMPLATE } from "@/lib/agents/config";
import { deploymentFingerprint } from "@/lib/agents/provision";

test("pre-fingerprint deployments read stale", () => {
  assert.equal(isAgentStale(null, "Layla", REAL_ESTATE_TEMPLATE), true);
});

test("matching fingerprints read fresh", () => {
  const current = deploymentFingerprint("Layla", REAL_ESTATE_TEMPLATE);
  assert.equal(isAgentStale(current, "Layla", REAL_ESTATE_TEMPLATE), false);
});

test("platform drift reads stale without any server round trip", () => {
  const before = deploymentFingerprint("Layla", REAL_ESTATE_TEMPLATE);
  const drifted = {
    ...REAL_ESTATE_TEMPLATE,
    mission: `${REAL_ESTATE_TEMPLATE.mission} Plus punctuality.`,
  };
  assert.equal(isAgentStale(before, "Layla", drifted), true);
});
