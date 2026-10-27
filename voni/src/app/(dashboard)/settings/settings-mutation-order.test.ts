import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ticket 06, seam: server-mutation auth ordering (settings actions). Catches:
// input parsing before authentication. Misses: live auth — the node runner
// has no session, so ordering and preserved outcomes are asserted on the real
// sources. House rule (siblings auth-first): createAgentAction, queueBulkAction,
// updateWorkspaceSettings resolve requireCtx() before touching input.
const here = dirname(fileURLToPath(import.meta.url));
const settingsSource = readFileSync(join(here, "actions.ts"), "utf8");
const agentsSource = readFileSync(
  join(here, "..", "agents", "actions.ts"),
  "utf8",
);
const campaignsSource = readFileSync(
  join(here, "..", "campaigns", "actions.ts"),
  "utf8",
);

function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const next = source.indexOf("export async function", start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

test("voice-prefs update authenticates before parsing input", () => {
  const body = fnBody(settingsSource, "updateCopilotVoicePrefs");
  assert.ok(body.includes("requireCtx()"), "still authenticates");
  assert.ok(body.includes("safeParse"), "still validates input");
  assert.ok(
    body.indexOf("requireCtx()") < body.indexOf("safeParse"),
    "requireCtx() runs above copilotVoicePrefsSchema.safeParse",
  );
});

test("provider-connection update authenticates before parsing input", () => {
  const body = fnBody(settingsSource, "setProviderConnection");
  assert.ok(body.includes("requireCtx()"), "still authenticates");
  assert.ok(body.includes("safeParse"), "still validates input");
  assert.ok(
    body.indexOf("requireCtx()") < body.indexOf("safeParse"),
    "requireCtx() runs above providerConnectionSchema.safeParse",
  );
});

test("sibling mutations stay auth-first (regression guard)", () => {
  const create = fnBody(agentsSource, "createAgentAction");
  assert.ok(
    create.indexOf("requireCtx()") < create.indexOf("safeParse"),
    "createAgentAction stays auth-first",
  );
  const queue = fnBody(campaignsSource, "queueBulkAction");
  assert.ok(
    queue.indexOf("requireCtx()") < queue.indexOf("safeParse"),
    "queueBulkAction stays auth-first",
  );
  const workspace = fnBody(settingsSource, "updateWorkspaceSettings");
  assert.ok(workspace.includes("requireCtx()"), "updateWorkspaceSettings authenticates");
  assert.ok(workspace.includes("workspaceSchema.parse"), "updateWorkspaceSettings validates");
  assert.ok(
    workspace.indexOf("requireCtx()") < workspace.indexOf("workspaceSchema.parse"),
    "updateWorkspaceSettings stays auth-first",
  );
});

test("same mutation outcomes: messages and validation preserved", () => {
  // Voice prefs: invalid input still returns the picker message, success
  // still returns the saved message; auth failure still throws "Not signed
  // in" from requireCtx for the try/catch to convert.
  const voice = fnBody(settingsSource, "updateCopilotVoicePrefs");
  assert.ok(voice.includes("Pick a voice and a language from the lists."));
  assert.ok(voice.includes("Voice copilot updated."));
  // Provider connection: unknown providers still rejected, owner gate kept.
  const providers = fnBody(settingsSource, "setProviderConnection");
  assert.ok(providers.includes("Unknown provider."));
  assert.ok(providers.includes("Only workspace owners can manage provider connections."));
  assert.ok(providers.includes("Provider connected."));
  assert.ok(providers.includes("Provider disconnected."));
});
