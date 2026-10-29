import test from "node:test";
import assert from "node:assert/strict";
import { isAgentStale } from "./platform-refresh";
import { buildStoredAgent } from "@/lib/agents/body";
import { REAL_ESTATE_TEMPLATE } from "@/lib/agents/config";
import { agentBodyFingerprint } from "@/lib/agents/fingerprint";
import { deploymentFingerprint, tenantAgentProfile } from "@/lib/agents/provision";

const EXPERIMENT_LLM = [
  {
    base_url: "https://llm.example.test/v1",
    model: "experiment",
    api_key: "sk-write-only",
  },
];

test("removing an override is a fingerprint change, so a refresh is owed", () => {
  const overridden = buildStoredAgent({
    name: "Layla",
    config: REAL_ESTATE_TEMPLATE,
    profile: {
      ...tenantAgentProfile(REAL_ESTATE_TEMPLATE),
      modelOverride: EXPERIMENT_LLM,
    },
  });
  const withOverride = agentBodyFingerprint(overridden);
  const desired = deploymentFingerprint("Layla", REAL_ESTATE_TEMPLATE);

  assert.notEqual(
    withOverride,
    desired,
    "the removed override moves the whole-body fingerprint",
  );
  assert.equal(
    isAgentStale(withOverride, "Layla", REAL_ESTATE_TEMPLATE),
    true,
    "a deployed override the desired body no longer carries is owed a refresh",
  );
  assert.equal(
    isAgentStale(desired, "Layla", REAL_ESTATE_TEMPLATE),
    false,
    "after the refresh the same routine check sends nothing",
  );
});

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
