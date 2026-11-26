/**
 * The console cards' fold memory, exercised through a fake `Storage` because
 * this runner cannot render a client component.
 *
 * The behaviour that matters to the operator is the storage contract: a card
 * nobody opened is collapsed, an opened card is still open when the page is
 * loaded again, and one card's choice is never another card's. Hydration safety
 * is asserted where it is written — the hook starts collapsed and only reads
 * storage after mount.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cardDisclosureKey,
  readCardOpen,
  writeCardOpen,
  type CardDisclosureStorage,
} from "@/components/card-disclosure";

class MemoryStorage implements CardDisclosureStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("a card nobody has opened is collapsed", () => {
  assert.equal(readCardOpen("email-targets-card", new MemoryStorage()), false);
});

test("an opened card is still open when the page loads again", () => {
  const storage = new MemoryStorage();
  writeCardOpen("email-proxy-card", true, storage);

  // A remount re-reads the stored key; there is no second in-memory copy that
  // could disagree with what a reload would see.
  assert.equal(readCardOpen("email-proxy-card", storage), true);
  assert.equal(
    storage.getItem(cardDisclosureKey("email-proxy-card")),
    JSON.stringify({ version: 1, data: true }),
  );
});

test("one card's state never opens another card", () => {
  const storage = new MemoryStorage();
  writeCardOpen("email-rotation-card", true, storage);

  assert.equal(readCardOpen("email-rotation-card", storage), true);
  assert.equal(readCardOpen("email-targets-card", storage), false);
  assert.equal(readCardOpen("email-github-source", storage), false);
  assert.equal(readCardOpen("email-burst-card", storage), false);
});

test("closing an opened card is remembered as closed", () => {
  const storage = new MemoryStorage();
  writeCardOpen("email-targets-card", true, storage);
  writeCardOpen("email-targets-card", false, storage);

  assert.equal(readCardOpen("email-targets-card", storage), false);
});

test("corrupt bytes read as collapsed rather than open", () => {
  const storage = new MemoryStorage();
  storage.setItem(cardDisclosureKey("email-targets-card"), "{not json");
  assert.equal(readCardOpen("email-targets-card", storage), false);
});

test("storage that refuses reads folded and never throws", () => {
  const refusing: CardDisclosureStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };

  assert.equal(readCardOpen("email-targets-card", refusing), false);
  assert.doesNotThrow(() => writeCardOpen("email-targets-card", true, refusing));
});

test("the hook restores after mount, so server and first client render agree", () => {
  const source = readFileSync(
    new URL("./card-disclosure.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const \[open, setOpen\] = useState\(false\)/,
    "the first render is always collapsed",
  );
  assert.doesNotMatch(
    source,
    /useState\(\s*\(\s*\)\s*=>\s*readCardOpen|useState\(readCardOpen/,
    "reading storage in an initializer would make the first client render disagree with the server",
  );
  const effectAt = source.indexOf("useEffect(");
  const readAt = source.indexOf("readCardOpen(cardId)");
  assert.ok(effectAt > 0 && readAt > effectAt, "storage is read inside the effect");
});
