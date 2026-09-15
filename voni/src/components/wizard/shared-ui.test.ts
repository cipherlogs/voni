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

test("TagField is a token box: pills inside, inline composer, x-remove", () => {
  const source = read("tag-field.tsx");
  // Pills + composer share one box; composer is a plain input, not InputGroup.
  assert.ok(source.includes("render={<span"));
  assert.ok(source.includes("Edit ${tag}"));
  assert.ok(source.includes("Remove ${tag}"));
  assert.ok(source.includes("startEditing"));
  // Commit on Enter/blur, IME-safe, Esc cancels, no Backspace deletion.
  assert.ok(source.includes("isComposing"));
  assert.ok(source.includes("keyCode !== 229"));
  assert.ok(source.includes("onBlur"));
  assert.ok(source.includes("Escape"));
  assert.ok(source.includes("Backspace in an empty input intentionally deletes nothing"));
  // No action buttons at all: no Add/Update/Cancel chrome.
  assert.ok(!source.includes(">Add<"));
  assert.ok(!source.includes(">Update<"));
  assert.ok(!source.includes(">Cancel<"));
  assert.ok(!source.includes("Plus")); 
  // How-to hints are screen-reader-only; count stays visible.
  assert.ok(source.includes("sr-only"));
  assert.ok(source.includes("values.length}/{maxCount}"));
  // Suggestion chips move: only non-added ones render.
  assert.ok(source.includes("available"));
  // Errors never tint valid pills: no data-invalid on the box, only
  // aria-invalid on the composer plus the message below.
  assert.ok(!source.includes("data-invalid"));
  assert.ok(source.includes("aria-invalid"));
  assert.ok(!source.includes("size-3"));
});

test("VoiceField merges language chips and voice cards, real clips only", () => {
  const source = read("voice-field.tsx");
  // One decision, not two controls: chips filter, picking a voice sets its
  // language implicitly. Cards ride a stock Carousel: side chevrons plus
  // snap dots, no checkmarks — pressed cards are the selection.
  assert.ok(source.includes("ToggleGroup"));
  assert.ok(source.includes("Spoken language"));
  assert.ok(source.includes("voiceForLanguage"));
  assert.ok(source.includes("Carousel"));
  assert.ok(source.includes("CarouselItem"));
  assert.ok(source.includes("CarouselPrevious"));
  assert.ok(source.includes("CarouselNext"));
  assert.ok(source.includes("scrollSnapList"));
  assert.ok(source.includes("Go to voice page"));
  // Center-mode carousel: the selected card glides to center via Embla's
  // native animated scrollTo — one call site only (selectVoice; never the
  // click-preview handler, which fires on the same tap and would jitter).
  assert.ok(source.includes('align: "center"'));
  // Edge snaps must center too: the default trimSnaps parks the first and
  // last slides at the track edges instead.
  assert.ok(source.includes("containScroll: false"));
  assert.ok(source.includes("api.scrollTo(idx"));
  assert.ok(source.includes("prefers-reduced-motion"));
  assert.ok(!source.includes("align: \"start\""));
  {
    const start = source.indexOf("const previewVoice");
    const previewFn = source.slice(start, source.indexOf("};", start));
    assert.ok(!previewFn.includes("scrollTo"));
  }
  assert.ok(!source.includes("speechSynthesis"));
  // Real AssemblyAI clips: no browser synthesis anywhere near this picker.
  // The card itself is the preview control — no separate play button.
  assert.ok(source.includes("/voices/"));
  assert.ok(source.includes("previewVoice"));
  // grid-list-02 card idiom (DESIGN pin): CardContent row + AvatarImage
  // portrait on the grid-list surface (border shadow-sm, hover border +
  // shadow). Selection keeps the primary border + ring tokens; the avatar is
  // illustrative, not the real talent, and presents is an inferred UI field.
  assert.ok(source.includes("grid-list-02"));
  assert.ok(source.includes("CardContent"));
  assert.ok(source.includes("AvatarImage"));
  assert.ok(source.includes("/voices/avatars/"));
  // No stretched-link anchor on the card — the toggle itself is the control.
  assert.ok(!source.includes("<a "));
  assert.ok(!source.includes("absolute inset-0"));
  assert.ok(source.includes("hover:border-muted-foreground"));
  assert.ok(source.includes("hover:shadow-md"));
  assert.ok(source.includes("flex items-center gap-4 p-4"));
  assert.ok(source.includes("inferred UI field"));
  assert.ok(source.includes("illustrative portrait"));
  // jean (unspecified/Neutral) is portraitless — initials tile only, so no
  // photo mis-cues a gender for the neutral slot.
  assert.ok(source.includes("PORTRAITLESS"));
  assert.ok(source.includes('"jean"'));
  // ai-01 composer-card idiom (DESIGN.md §4): fill sweep culled, progress
  // via token wash; avatar on AvatarFallback tokens.
  assert.ok(!source.includes("voni-voice-fill"));
  assert.ok(!source.includes("--preview-duration"));
  assert.ok(source.includes("bg-primary/10"));
  assert.ok(!source.includes("PreviewButton"));
  assert.ok(!source.includes("voiceTunables"));
  assert.ok(!source.includes("Test this agent"));
  // Secondary line is the accent badge only — presentsLabel survives purely
  // as sr-only text inside the card's aria-label. (The single-voice branch
  // keeps a muted helper line; the pin below targets the card markup.)
  assert.ok(source.includes("presentsLabel"));
  // Token avatars, accent flag badges, selected ring — no
  // waveform, checkmark, or custom avatar style. The old hash-surface
  // helper (voice-avatar.tsx) is deleted — portraits + fallback only.
  assert.ok(source.includes("VoiceCardAvatar"));
  assert.ok(source.includes("ACCENT_FLAG"));
  assert.ok(source.includes("AvatarFallback"));
  assert.ok(source.includes("AudioLines"));
  assert.ok(!source.includes("waveformHeights"));
  assert.ok(source.includes("flagFor"));
  assert.ok(source.includes("data-[state=on]:border-primary"));
  assert.ok(source.includes("data-[state=on]:ring-1"));
  assert.ok(!source.includes("avatarStyle"));
  assert.ok(!source.includes("surfaceForVoice"));
  assert.ok(!source.includes("<Check"));
  // Single-voice languages say so instead of offering a one-item choice.
  assert.ok(source.includes("already selected"));
  // Announcements stay sr-only; the visible "Voice switched to …" line is
  // gone — the selection is visible on the card itself.
  assert.ok(source.includes('aria-live="polite"'));
  assert.ok(!source.includes("mt-2 text-xs"));
});

test("ConversationPicker is the merged Language & voice section", () => {
  const source = read("conversation-picker.tsx");
  assert.ok(source.includes("VoiceField"));
  assert.ok(!source.includes("VoiceCarousel"));
  assert.ok(!source.includes("SelectTrigger"));
  assert.ok(!source.includes("max-w-44"));
});

test("Form layout tokens: heading gaps, flat sections, static footer", () => {
  const source = read("form-layout.tsx");
  assert.ok(source.includes("mb-6 md:mb-8"));
  assert.ok(source.includes("gap-2"));
  assert.ok(source.includes("gap-6"));
  // Flat side-label sections (form-layout-03): no Card chrome on form groups.
  assert.ok(source.includes("grid grid-cols-1 gap-10 md:grid-cols-3"));
  assert.ok(source.includes("sm:max-w-3xl md:col-span-2"));
  assert.ok(source.includes('"my-8"'));
  assert.ok(source.includes("FormSection"));
  assert.ok(source.includes("FormSectionHeading"));
  assert.ok(source.includes("FormSectionSeparator"));
  // FormCard is a plain wrapper now — settings-view keeps its own stack via
  // FormCardSections. No Card import survives in this file.
  assert.ok(!source.includes("ui/card"));
  assert.ok(!source.includes("py-4 md:py-6"));
  // Normal document flow — a stuck footer covered scrolled form content.
  // dialog-11 terminal bar (DESIGN.md §4): ruled Separator, not a border-t div.
  assert.ok(!source.includes("sticky"));
  assert.ok(!source.includes("--job-pill-h"));
  assert.ok(source.includes("<Separator"));
});

test("Button has no custom touch sizes; stock sizes stay intact", () => {
  const source = readFileSync(join(DIR, "../ui/button.tsx"), "utf8");
  assert.ok(!source.includes("icon-touch"));
  assert.ok(!source.includes("touch:"));
  assert.ok(source.includes("cursor-pointer"));
  assert.ok(source.includes("disabled:pointer-events-none"));
});
