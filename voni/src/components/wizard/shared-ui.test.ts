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

test("TagField is a bubble composer with tap-to-edit tags", () => {
  const source = read("tag-field.tsx");
  assert.ok(source.includes("InputGroupInput"));
  assert.ok(source.includes("InputGroupAddon"));
  assert.ok(source.includes("rounded-full"));
  assert.ok(source.includes("isComposing"));
  assert.ok(source.includes("keyCode !== 229"));
  assert.ok(source.includes("Backspace in an empty input intentionally deletes nothing"));
  // Tap-to-edit through the Badge render prop; Remove only while editing.
  assert.ok(source.includes("render={"));
  assert.ok(source.includes("Edit ${tag}"));
  assert.ok(source.includes("startEditing"));
  assert.ok(!source.includes("Remove ${tag}"));
  // No persistent icon buttons and no icon sizing classes.
  assert.ok(!source.includes("lucide-react"));
  assert.ok(!source.includes("size-3"));
  // Suggestion chips move: only non-added ones render.
  assert.ok(source.includes("available"));
  assert.ok(source.includes("aria-pressed") === false);
  // Validation states per the forms rule.
  assert.ok(source.includes("data-invalid"));
  assert.ok(source.includes("aria-invalid"));
});

test("VoiceCarousel uses the shadcn Carousel with dots and tap-to-select", () => {
  const source = read("voice-carousel.tsx");
  assert.ok(source.includes("CarouselContent"));
  assert.ok(source.includes("CarouselItem"));
  assert.ok(source.includes("CarouselPrevious"));
  assert.ok(source.includes("CarouselNext"));
  assert.ok(source.includes("setApi"));
  assert.ok(source.includes("selectedScrollSnap"));
  assert.ok(source.includes("Go to voice"));
  assert.ok(source.includes("aria-pressed"));
  // Samples play on user-initiated slides only, never on mount.
  assert.ok(source.includes("interacted"));
  assert.ok(source.includes("speechSynthesis"));
  assert.ok(source.includes("aria-live=\"polite\""));
  // Stock Card composition for slides, no icon sizing classes.
  assert.ok(source.includes("CardContent"));
  assert.ok(!source.includes("lucide-react"));
});

test("ConversationPicker keeps the Select composition with flag-plus-text labels", () => {
  const source = read("conversation-picker.tsx");
  assert.ok(source.includes("SelectGroup"));
  assert.ok(source.includes("SelectLabel"));
  assert.ok(source.includes("SelectItem"));
  assert.ok(source.includes("<span aria-hidden>{lang.flag}</span>"));
  assert.ok(source.includes("{lang.label}"));
  assert.ok(source.includes("VoiceCarousel"));
  assert.ok(source.includes("voiceForLanguage"));
  assert.ok(source.includes("aria-live=\"polite\""));
});

test("Form layout tokens: heading gaps, card padding, sticky JobPill-aware footer", () => {
  const source = read("form-layout.tsx");
  assert.ok(source.includes("mb-6 md:mb-8"));
  assert.ok(source.includes("gap-2"));
  assert.ok(source.includes("gap-6"));
  assert.ok(source.includes("py-4 md:py-6"));
  assert.ok(source.includes("--card-spacing"));
  assert.ok(source.includes("sticky"));
  assert.ok(source.includes("--job-pill-h"));
  assert.ok(source.includes("safe-area-inset-bottom"));
  assert.ok(source.includes("focus-within:static"));
});

test("Button has no custom touch sizes; stock sizes stay intact", () => {
  const source = readFileSync(join(DIR, "../ui/button.tsx"), "utf8");
  assert.ok(!source.includes("icon-touch"));
  assert.ok(!source.includes("touch:"));
  assert.ok(source.includes("cursor-pointer"));
  assert.ok(source.includes("disabled:pointer-events-none"));
});
