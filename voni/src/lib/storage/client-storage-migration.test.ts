import test from "node:test";
import assert from "node:assert/strict";
import { parseEditDraftCache } from "../../app/(dashboard)/agents/[id]/edit-agent";
import { parseWizardDraftCache } from "../../components/agent-wizard/use-wizard-draft";
import { wrapVersioned, STORAGE_VERSION } from "./versioned";
import { loadCallMemory, saveCallMemory, type CallMemorySnapshot } from "../demo/hold";

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test("edit drafts migrate: legacy bare and versioned envelopes both restore", () => {
  const legacy = JSON.stringify({ name: "Acme", config: { voice: "anna" } });
  const migrated = parseEditDraftCache(legacy);
  assert.deepEqual(migrated, { name: "Acme", config: { voice: "anna" } });

  const versioned = wrapVersioned({ name: "Acme", config: { voice: "anna" } });
  assert.deepEqual(parseEditDraftCache(versioned), { name: "Acme", config: { voice: "anna" } });

  for (const bad of [null, "", "{not json", "{}", JSON.stringify({ name: 42 })]) {
    assert.equal(parseEditDraftCache(bad), null, String(bad)?.slice(0, 40));
  }
  const future = JSON.stringify({ version: STORAGE_VERSION + 99, data: { name: "Acme", config: {} } });
  assert.equal(parseEditDraftCache(future), null, "future versions fall back safely");
});

test("wizard drafts migrate: legacy bare and versioned envelopes both restore", () => {
  const draft = {
    goals: ["Book viewings"],
    tasks: [],
    agentName: "Acme",
    styleTraits: [],
    conversationLanguage: "en",
    voiceId: "anna",
  };
  const legacy = JSON.stringify({ draft, step: 1 });
  const parsedLegacy = parseWizardDraftCache(legacy);
  assert.ok(parsedLegacy);
  assert.deepEqual(parsedLegacy.draft.goals, ["Book viewings"]);

  const versioned = wrapVersioned({ draft, step: 1 });
  const parsedVersioned = parseWizardDraftCache(versioned);
  assert.ok(parsedVersioned);
  assert.deepEqual(parsedVersioned.draft.goals, ["Book viewings"]);

  assert.equal(parseWizardDraftCache(JSON.stringify({ draft: null })), null);
  const future = JSON.stringify({ version: STORAGE_VERSION + 99, data: { draft, step: 1 } });
  assert.equal(parseWizardDraftCache(future), null, "future versions fall back safely");
});

test("call memory migrates: legacy bare and versioned envelopes both restore within the cap", () => {
  const snap: CallMemorySnapshot = {
    savedAt: 1000,
    voiceId: "anna",
    turns: [{ role: "user", text: "We sell solar panels." }],
    talkSeconds: 42,
    strikes: 1,
    sessionId: "sess_1",
  };
  const legacyStore = memoryStore();
  legacyStore.setItem("voni:demo-call", JSON.stringify(snap));
  assert.deepEqual(loadCallMemory(1000 + 60_000, legacyStore), snap);

  const versionedStore = memoryStore();
  saveCallMemory(snap, versionedStore);
  const raw = versionedStore.map.get("voni:demo-call") ?? "";
  const envelope = JSON.parse(raw) as { version: number; data: unknown };
  assert.equal(envelope.version, STORAGE_VERSION, "writes are versioned and minimized");
  assert.deepEqual(Object.keys(envelope).sort(), ["data", "version"]);
  assert.deepEqual(loadCallMemory(1000 + 60_000, versionedStore), snap);
});
