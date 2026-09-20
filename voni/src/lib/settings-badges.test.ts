import test from "node:test";
import assert from "node:assert/strict";
import {
  buildServiceReadiness,
  settingsTileBadges,
} from "./settings-badges";

test("voice badge names the saved voice and language", () => {
  const badges = settingsTileBadges({
    role: "owner",
    voice: { voiceId: "alba", language: "en" },
    connectedProviders: 1,
    servicesReady: 2,
    servicesTotal: 4,
    phoneTotal: 1,
    phoneUnassigned: 0,
  });
  assert.deepEqual(badges.voice, { text: "Alba · English", variant: "secondary" });
  const auto = settingsTileBadges({
    role: "owner",
    voice: { voiceId: "ivy", language: "auto" },
    connectedProviders: 0,
    servicesReady: 0,
    servicesTotal: 4,
    phoneTotal: 0,
    phoneUnassigned: 0,
  });
  assert.deepEqual(auto.voice, { text: "Ivy · Auto", variant: "secondary" });
});

test("workspace badge surfaces owner-gating before edits", () => {
  const owner = settingsTileBadges({
    role: "owner",
    voice: { voiceId: "ivy", language: "en" },
    connectedProviders: 0,
    servicesReady: 0,
    servicesTotal: 4,
    phoneTotal: 0,
    phoneUnassigned: 0,
  });
  assert.deepEqual(owner.workspace, { text: "Owner", variant: "secondary" });
  const member = settingsTileBadges({
    role: "member",
    voice: { voiceId: "ivy", language: "en" },
    connectedProviders: 0,
    servicesReady: 0,
    servicesTotal: 4,
    phoneTotal: 0,
    phoneUnassigned: 0,
  });
  assert.deepEqual(member.workspace, { text: "Read-only", variant: "outline" });
});

test("services badge counts connections and readiness in one line", () => {
  const partial = settingsTileBadges({
    role: "owner",
    voice: { voiceId: "ivy", language: "en" },
    connectedProviders: 1,
    servicesReady: 2,
    servicesTotal: 4,
    phoneTotal: 0,
    phoneUnassigned: 0,
  });
  assert.deepEqual(partial.services, { text: "1 connected · 2/4 ready", variant: "outline" });
  const ready = settingsTileBadges({
    role: "owner",
    voice: { voiceId: "ivy", language: "en" },
    connectedProviders: 3,
    servicesReady: 4,
    servicesTotal: 4,
    phoneTotal: 0,
    phoneUnassigned: 0,
  });
  assert.deepEqual(ready.services, { text: "3 connected · 4/4 ready", variant: "secondary" });
});

test("numbers badge counts registrations and unassigned rows", () => {
  const empty = settingsTileBadges({
    role: "owner",
    voice: { voiceId: "ivy", language: "en" },
    connectedProviders: 0,
    servicesReady: 0,
    servicesTotal: 4,
    phoneTotal: 0,
    phoneUnassigned: 0,
  });
  assert.deepEqual(empty.numbers, { text: "No numbers", variant: "outline" });
  const one = settingsTileBadges({
    role: "owner",
    voice: { voiceId: "ivy", language: "en" },
    connectedProviders: 0,
    servicesReady: 0,
    servicesTotal: 4,
    phoneTotal: 1,
    phoneUnassigned: 0,
  });
  assert.deepEqual(one.numbers, { text: "1 number", variant: "secondary" });
  const mixed = settingsTileBadges({
    role: "owner",
    voice: { voiceId: "ivy", language: "en" },
    connectedProviders: 0,
    servicesReady: 0,
    servicesTotal: 4,
    phoneTotal: 2,
    phoneUnassigned: 1,
  });
  assert.deepEqual(mixed.numbers, { text: "2 numbers · 1 unassigned", variant: "outline" });
});

test("account names the Google-only provider; operator names the admin gate; appearance stays client-owned", () => {
  const badges = settingsTileBadges({
    role: "owner",
    voice: { voiceId: "ivy", language: "en" },
    connectedProviders: 0,
    servicesReady: 0,
    servicesTotal: 4,
    phoneTotal: 0,
    phoneUnassigned: 0,
  });
  assert.deepEqual(badges.account, { text: "Google", variant: "secondary" });
  assert.deepEqual(badges.operator, { text: "Admin", variant: "secondary" });
  assert.equal(badges.appearance, undefined);
});

test("service readiness matches the services section rules", () => {
  const all = buildServiceReadiness({
    assemblyaiConfigured: true,
    telnyxConfigured: true,
    telnyxConnectionId: "conn-1",
    telnyxCallerNumber: "+971501234567",
    llmConfigured: true,
    cartesiaConfigured: true,
    cartesiaVoiceId: "voice-1",
  });
  assert.deepEqual(
    all.map((service) => service.configured),
    [true, true, true, true],
  );
  const missingPhone = buildServiceReadiness({
    assemblyaiConfigured: true,
    telnyxConfigured: true,
    telnyxConnectionId: "conn-1",
    telnyxCallerNumber: null,
    llmConfigured: true,
    cartesiaConfigured: true,
    cartesiaVoiceId: "voice-1",
  });
  assert.equal(missingPhone.find((service) => service.id === "phone")?.configured, false);
  const missingLlm = buildServiceReadiness({
    assemblyaiConfigured: true,
    telnyxConfigured: true,
    telnyxConnectionId: "conn-1",
    telnyxCallerNumber: "+971501234567",
    llmConfigured: false,
    cartesiaConfigured: false,
    cartesiaVoiceId: null,
  });
  assert.equal(missingLlm.find((service) => service.id === "llm")?.configured, false);
  assert.equal(missingLlm.find((service) => service.id === "voice-note")?.configured, false);
});
