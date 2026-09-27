import test from "node:test";
import assert from "node:assert/strict";
import { tagForMint, type TestTagRow } from "./test-tag-registry";
import { signTagToken, verifyTagToken } from "./call-token";

const row = (id: string, tag: string) => ({ id, tag, language: "en" }) as TestTagRow;

test("the token route keeps a live tag the browser holds, and issues a fresh one otherwise", async () => {
  const issued: string[] = [];
  const deps = {
    load: async (id: string) => (id === "live" ? row("live", "Lime 42") : null),
    issue: async (language: string) => {
      issued.push(language);
      return row("new", "Lima 17");
    },
  };
  const now = Date.now();
  const valid = verifyTagToken("k", signTagToken("k", "live", now), now);
  assert.deepEqual(await tagForMint(valid, "es", deps), { tag: row("live", "Lime 42"), carried: true });
  assert.deepEqual(issued, [], "a carried tag issues nothing");

  const forged = verifyTagToken("k", signTagToken("other-key", "live", now), now);
  assert.equal(forged, null);
  assert.deepEqual(await tagForMint(forged, "es", deps), { tag: row("new", "Lima 17"), carried: false });

  const expired = verifyTagToken("k", signTagToken("k", "live", now - 25 * 3600_000), now);
  assert.equal(expired, null, "a token past its day is refused");

  const gone = { id: "deleted" };
  assert.deepEqual(await tagForMint(gone, "es", deps), { tag: row("new", "Lima 17"), carried: false }, "a signed id no longer live");
  assert.deepEqual(issued, ["es", "es"], "fresh tags come in the call's language");
});

test("a tag whose email was already answered carries only within its own call", async () => {
  const matched = { ...row("done", "Lotus 82"), matchedMessageId: "m1" } as TestTagRow;
  const deps = {
    load: async () => matched,
    issue: async () => row("new", "Lima 17"),
  };
  // sess 2026-09-27: a new call on the old tag replied at the greeting.
  assert.deepEqual(await tagForMint({ id: "done" }, "en", deps), { tag: row("new", "Lima 17"), carried: false });
  assert.deepEqual(
    await tagForMint({ id: "done", continuing: true }, "en", deps),
    { tag: matched, carried: true },
    "a rejoin of the same call keeps its tag (its reply and code)",
  );
});
