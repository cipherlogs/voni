import test from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_VERSION,
  isVersionedEnvelope,
  wrapVersioned,
  parseVersioned,
  createParseCache,
} from "./versioned";

const isRecord = (d: unknown): d is Record<string, string> =>
  typeof d === "object" && d !== null;

test("versioned envelope round-trips the minimized shape", () => {
  const wrapped = wrapVersioned({ a: "1" });
  const parsed: unknown = JSON.parse(wrapped);
  assert.equal((parsed as { version: number }).version, STORAGE_VERSION);
  assert.deepEqual((parsed as { data: unknown }).data, { a: "1" });
  // Minimized: envelope carries only version + data.
  assert.deepEqual(Object.keys(parsed as object).sort(), ["data", "version"]);
});

test("parseVersioned reads current envelopes and migrates legacy bare shapes", () => {
  const validate = (d: unknown): d is { voiceId: string } =>
    typeof d === "object" && d !== null && typeof (d as { voiceId?: unknown }).voiceId === "string";
  const migrateLegacy = (legacy: unknown): { voiceId: string } | null =>
    validate(legacy) ? (legacy as { voiceId: string }) : null;

  const current = wrapVersioned({ voiceId: "anna" });
  assert.deepEqual(parseVersioned(current, { validate, migrateLegacy }), { voiceId: "anna" });

  const legacy = JSON.stringify({ voiceId: "anna" });
  assert.deepEqual(parseVersioned(legacy, { validate, migrateLegacy }), { voiceId: "anna" });
});

test("parseVersioned falls back safely on corrupt, foreign, and future shapes", () => {
  const validate = (d: unknown): d is { voiceId: string } =>
    typeof d === "object" && d !== null && typeof (d as { voiceId?: unknown }).voiceId === "string";
  const migrateLegacy = (): { voiceId: string } | null => null;
  assert.equal(parseVersioned(null, { validate, migrateLegacy }), null);
  assert.equal(parseVersioned("", { validate, migrateLegacy }), null);
  assert.equal(parseVersioned("{not json", { validate, migrateLegacy }), null);
  assert.equal(parseVersioned(JSON.stringify({ nope: 1 }), { validate, migrateLegacy }), null);
  const future = JSON.stringify({ version: STORAGE_VERSION + 99, data: { voiceId: "anna" } });
  assert.equal(parseVersioned(future, { validate, migrateLegacy }), null);
});

test("isVersionedEnvelope narrows only {version, data} shapes", () => {
  assert.equal(isVersionedEnvelope({ version: 1, data: {} }), true);
  assert.equal(isVersionedEnvelope({ version: "1", data: {} }), false);
  assert.equal(isVersionedEnvelope({ version: 1 }), false);
  assert.equal(isVersionedEnvelope(null), false);
  assert.equal(isVersionedEnvelope("voni:test-tag"), false);
});

test("createParseCache caches repeated reads within their scope", () => {
  let parses = 0;
  const parse = (raw: string | null): unknown => {
    parses += 1;
    return raw ? JSON.parse(raw) : null;
  };
  const cached = createParseCache(parse);
  const raw = JSON.stringify({ a: "1" });
  cached(raw);
  cached(raw);
  cached(raw);
  assert.equal(parses, 1, "same raw parses once");
  cached(JSON.stringify({ a: "2" }));
  assert.equal(parses, 2, "new raw re-parses");
  assert.ok(isRecord({}), "type guard sanity");
});
