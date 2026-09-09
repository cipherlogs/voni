import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyTagAdd,
  applyTagRemove,
  applyTagUpdate,
  isTagAdded,
} from "./tag-helpers";

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

test("applyTagAdd appends normalized text without splitting commas", () => {
  const result = applyTagAdd([], "  Qualify  leads, book   viewings  ", 12, 140);
  assert.equal(result.ok, true);
  assert.deepEqual((result as { values: string[] }).values, [
    "Qualify leads, book viewings",
  ]);
});

test("applyTagAdd rejects empty, duplicates, overlong, and over-cap", () => {
  assert.equal(applyTagAdd([], "   ", 12, 140).ok, false);
  assert.equal(
    (applyTagAdd(["Qualify leads"], "qualify  LEADS", 12, 140) as { reason: string }).reason,
    "duplicate",
  );
  assert.equal(
    (applyTagAdd([], "x".repeat(141), 12, 140) as { reason: string }).reason,
    "too-long",
  );
  const full = Array.from({ length: 12 }, (_, i) => `Tag ${i}`);
  assert.equal(
    (applyTagAdd(full, "One more", 12, 140) as { reason: string }).reason,
    "capped",
  );
});

test("applyTagUpdate preserves position and allows saving unchanged", () => {
  const values = ["First", "Second", "Third"];
  const updated = applyTagUpdate(values, 1, "  Second, revised  ", 140);
  assert.equal(updated.ok, true);
  assert.deepEqual((updated as { values: string[] }).values, [
    "First",
    "Second, revised",
    "Third",
  ]);
  assert.ok(applyTagUpdate(values, 1, "second", 140).ok);
  assert.ok(!applyTagUpdate(values, 1, "FIRST", 140).ok);
  assert.ok(!applyTagUpdate(values, 1, "", 140).ok);
});

test("applyTagRemove drops by index; isTagAdded matches case-insensitively", () => {
  assert.deepEqual(applyTagRemove(["a", "b", "c"], 1), ["a", "c"]);
  assert.ok(isTagAdded(["Friendly"], "FRIENDLY"));
  assert.ok(!isTagAdded(["Friendly"], "Calm"));
  assert.ok(!isTagAdded(["Friendly"], "   "));
});

test("TagField uses Field/InputGroup/Badge/Button — no contenteditable or tag textarea", () => {
  const source = read("tag-field.tsx");
  assert.match(source, /from "@\/components\/ui\/field"/);
  assert.match(source, /InputGroupInput/);
  assert.match(source, /InputGroupAddon/);
  assert.match(source, /from "@\/components\/ui\/badge"/);
  assert.doesNotMatch(source, /contenteditable/i);
  assert.doesNotMatch(source, /\<textarea/i);
  // Enter commits, IME composition does not, Backspace deletes nothing.
  assert.match(source, /isComposing/);
  assert.match(source, /keyCode !== 229/);
  assert.match(source, /Backspace in an empty input intentionally deletes nothing/);
  // Accessible edit/remove per tag + suggestion Added state.
  assert.match(source, /aria-label=\{`Edit \$\{tag\}`\}/);
  assert.match(source, /aria-label=\{`Remove \$\{tag\}`\}/);
  assert.match(source, /aria-pressed=\{added\}/);
});

test("ConversationPicker uses Select composition with flag-plus-text labels", () => {
  const source = read("conversation-picker.tsx");
  assert.match(source, /SelectGroup/);
  assert.match(source, /SelectLabel/);
  assert.match(source, /SelectItem/);
  assert.ok(source.includes("<span aria-hidden>{lang.flag}</span>"));
  assert.ok(source.includes("{lang.label}"));
  assert.ok(source.includes("ACCENT_LABEL[voice.accent]"));
  assert.match(source, /voiceForLanguage/);
  assert.ok(source.includes('aria-live="polite"'));
});

test("Form layout tokens: heading gaps, card padding, sticky JobPill-aware footer", () => {
  const source = read("form-layout.tsx");
  assert.match(source, /mb-6 md:mb-8/);
  assert.match(source, /gap-2/);
  assert.match(source, /gap-6/);
  assert.match(source, /py-4 md:py-6/);
  assert.match(source, /--card-spacing/);
  assert.match(source, /sticky/);
  assert.match(source, /--job-pill-h/);
  assert.match(source, /safe-area-inset-bottom/);
  assert.match(source, /focus-within:static/);
});

test("Button ships touch and icon-touch sizes (44px / 44x44)", () => {
  const source = readFileSync(join(DIR, "../ui/button.tsx"), "utf8");
  assert.match(source, /touch: "h-auto min-h-11/);
  assert.match(source, /"icon-touch": "size-11/);
});
