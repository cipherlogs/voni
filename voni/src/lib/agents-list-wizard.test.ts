import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Ticket 04 pin (minimalist-editorial-pass): agents list + creation wizard in
// the editorial language. Source-text checks mirror the ticket checkboxes with
// the frozen logic kept byte-identical: badge derivation from the live job,
// list query, draft machine, validation, payloads, idempotency, placeholder
// actions, and copilot tools stay; only markup moves. Follows the existing
// source-text prior art (design-foundation.test.ts, landing-auth.test.ts,
// shell-dashboard.test.ts): no jsdom, read the real files that ship.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

function readRepo(relative: string): string {
  return readFileSync(join(srcRoot, relative), "utf8");
}

test("agents list keeps the bordered table idiom with frozen query and badge derivation", () => {
  const page = readRepo("app/(dashboard)/agents/page.tsx");
  const actions = readRepo("app/(dashboard)/agents/actions.ts");
  // Frozen query + badge derivation: the list resolves through the
  // generation-aware loader; badges derive from the live job, never a stored
  // flag; terminal placeholders stay deletable while running generations own
  // their row.
  assert.match(page, /listAgentsWithGeneration/, "list query stays");
  assert.match(actions, /listAgentsWithGeneration/, "loader stays exported");
  assert.match(page, /agent\.generationJobId && agent\.generationStatus/, "badge derives from the live job");
  assert.match(page, /agent\.generationStatus === "queued"/, "queued stays running");
  assert.match(page, /agent\.generationStatus === "running"/, "running stays running");
  assert.match(page, /Ready to review/, "ready copy stays");
  assert.match(page, /Generation failed/, "failed copy stays");
  assert.match(page, /Draft — not yet deployed/, "draft copy stays");
  assert.match(page, /Deployed and ready/, "deployed copy stays");
  assert.match(page, /gen\?\.running \? null/, "running generation owns the row (no row menu)");
  assert.match(page, /neverProvisioned=\{!agent\.assemblyaiAgentId\}/, "delete copy keys off provisioning");
  assert.match(page, /LiveAgentsRefresh/, "settled-job refresh stays");

  // Bordered table idiom (user pick, rollback 2026-09-23): the plain
  // `overflow-x-auto rounded-lg border` wrapper with no Card chrome, no
  // sticky columns, no visible count row, and no shortcut hint. Pinned so
  // future passes don't re-restyle it into the Card language. Segment
  // loading reads as the table shape like the inline fallback.
  assert.match(page, /<DataTable>/, "list sits in the shared bordered DataTable frame");
  assert.doesNotMatch(page, /<Card>/, "no Card chrome on the list");
  assert.doesNotMatch(page, /sticky left-0/, "no sticky columns on the list");
  assert.doesNotMatch(page, /Results: /, "no visible count row on the list");
  assert.match(page, /<Empty>/, "empty stays the shared idiom");
  assert.match(page, /variant="feature"/, "first-run empty keeps the feature disc");
  assert.match(page, /No agents yet/, "empty title stays");
  assert.match(page, /variant="outline"/, "empty action stays the boxed pair");
  assert.doesNotMatch(page, /<kbd/, "no shortcut hint on the list");
  assert.doesNotMatch(page, /cursor-pointer/, "row buttons keep the native arrow like every shared Button");
  assert.doesNotMatch(page, /bg-primary/, "no primary-color fills on the list");

  // Frozen shell: suspense stays around the rows, the inline fallback and
  // the segment loading both read as the table grid, and errors read
  // as the shared route card — pinned against the segment files that ship,
  // not just the page's inline fallback.
  assert.match(page, /<Suspense/, "rows stay behind their boundary");
  assert.match(page, /TableSkeleton/, "inline fallback stays the table shape");
  const agentsLoading = readRepo("app/(dashboard)/agents/loading.tsx");
  assert.match(agentsLoading, /TableSkeleton/, "segment loading stays the table shape");
  assert.match(agentsLoading, /PageHeaderSkeleton/, "segment loading keeps the header shape");
  assert.doesNotMatch(agentsLoading, /CardListSkeleton/, "segment loading never reads as cards");
  const agentsError = readRepo("app/(dashboard)/agents/error.tsx");
  assert.match(agentsError, /"use client"/, "segment error stays client");
  assert.match(agentsError, /RouteError/, "segment error stays shared");
  assert.match(agentsError, /retry/, "segment error keeps retry");
});

test("wizard step bodies, footer, and review restyle with handlers byte-identical", () => {
  const bodies = readRepo("components/agent-wizard/wizard-step-bodies.tsx");
  const footer = readRepo("components/wizard/form-layout.tsx");
  const wizard = readRepo("app/(dashboard)/agents/new/page.tsx");
  // Frozen draft machine: steps, validation, payloads, idempotency, and the
  // copilot tool contract stay; only markup moves.
  assert.match(wizard, /useWizardDraft/, "draft machine stays");
  assert.match(wizard, /WIZARD_STEPS/, "step source stays");
  assert.match(wizard, /composeBrief/, "brief compiler stays");
  assert.match(wizard, /generationIdempotencyKey/, "stable per-brief key stays");
  assert.match(wizard, /generation:retry:/, "fresh-key retry stays a new submission");
  assert.match(wizard, /ensureGenerationPlaceholderAction/, "placeholder write stays best-effort");
  assert.match(wizard, /getGenerationPlaceholderAction/, "placeholder resolve stays");
  assert.match(wizard, /markJobConsumed/, "consumed-job guard stays");
  assert.match(wizard, /wizard_propose_change/, "copilot propose tool stays");
  assert.match(wizard, /wizard_apply_exec/, "copilot apply executor stays");
  assert.match(wizard, /wizard_undo_propose/, "copilot undo tool stays");
  assert.match(wizard, /max-w-3xl/, "creation shell stays at the agent width");
  assert.match(wizard, /TimelineBar/, "onboarding-steps timeline stays");
  assert.match(wizard, /WizardFooter/, "dialog footer composition stays");
  assert.match(wizard, /GenerationRetryCard/, "terminal retry card stays");
  assert.match(wizard, /GenerationStatusCard/, "minimal-wait card stays");
  assert.match(wizard, /Back to editing/, "review dismiss stays a view change");

  // Step bodies: side-label density partners (heading + description + fields),
  // name at the medium width cap, sentence-case placeholders with no trailing
  // period, invalid states per the form primitives.
  assert.match(bodies, /What should your agent do\?/, "plan heading stays");
  assert.match(bodies, /Who should your agent be\?/, "personality heading stays");
  assert.match(bodies, /max-w-md/, "name control stays at the medium width cap");
  assert.doesNotMatch(bodies, /max-w-sm/, "auth-width name cap stays retired");
  assert.match(bodies, /placeholder="Add a goal"/, "goal placeholder stays sentence-case");
  assert.match(bodies, /placeholder="Add a task"/, "task placeholder stays sentence-case");
  assert.match(bodies, /placeholder="Name your agent"/, "name placeholder stays sentence-case");
  assert.match(bodies, /placeholder="Add a style"/, "style placeholder stays sentence-case");
  assert.doesNotMatch(bodies, /placeholder="[A-Z][a-z]+ [a-z]+\."/, "no trailing period on placeholders");
  assert.match(bodies, /FieldError/, "field errors stay on the shared primitive");
  assert.match(bodies, /aria-invalid/, "invalid states stay announced");

  // Transparent wrapping footer: separator plus secondary-left/primary-right,
  // wrapping on narrow with the primary on top when stacked.
  assert.match(footer, /<Separator/, "footer keeps its separator");
  assert.match(footer, /pt-4/, "footer keeps its spacing outside filled bodies");
  assert.match(footer, /justify-between/, "secondary stays left with the primary right");
  assert.match(footer, /flex-col-reverse/, "stacked footer keeps the primary on top");
  assert.match(footer, /sm:flex-row/, "footer returns to a row on desktop");
  assert.match(footer, /flex-wrap/, "footer wraps instead of squeezing");
  assert.match(wizard, /w-full sm:w-auto/, "footer actions share one responsive size");
  assert.match(wizard, /data-copilot-effect="view"/, "footer actions stay view-only for copilot");

  // Review: verifiable summary mirrors the saved fields with the ready badge
  // on token-only text; nothing saves until the footer says so.
  assert.match(wizard, /Review agent/, "review title stays");
  assert.match(wizard, /Nothing is saved until you say so/, "review honesty stays");
  assert.match(wizard, /Ready to save/, "ready badge stays");
  assert.match(wizard, /variant="secondary"/, "ready badge stays on the badge token");
  assert.match(wizard, /Deploy agent/, "review submit stays the deploy label");
  assert.match(wizard, /text-muted-foreground/, "summary meta stays on the muted token");
});

test("voice choice stays card interiors with deterministic motif avatars and toggle-as-control", () => {
  const voice = readRepo("components/wizard/voice-field.tsx");
  const bodies = readRepo("components/agent-wizard/wizard-step-bodies.tsx");
  // Grid-list interior: Card surface row with the size-10 avatar slot, hover
  // breath on the shared standard — interaction byte-identical, the toggle
  // stays the control with no stretched link.
  assert.match(voice, /ToggleGroupItem/, "toggle stays the control");
  assert.match(voice, /onValueChange=\{selectVoice\}/, "selection stays the toggle value");
  assert.match(voice, /previewVoice/, "card click stays select plus preview");
  assert.doesNotMatch(voice, /render=\{<a/, "no anchor rendered inside the toggle");
  assert.doesNotMatch(voice, /<a href/, "no link element inside the voice cards");
  assert.match(voice, /CardContent/, "card interior stays the grid-list row");
  assert.match(voice, /size-10/, "avatar slot stays the pinned size");
  assert.match(voice, /duration-\[var\(--motion-standard\)\]/, "voice cards breathe on the shared standard");
  assert.match(voice, /VoiceMotif/, "avatar slot stays the deterministic motif");
  assert.match(voice, /hash/, "motif stays hash-derived with no per-voice cases");
  assert.match(voice, /aria-label=\{`Voice/, "card stays labelled for assistive tech");
  assert.match(voice, /presentsLabel/, "gender survives only inside the screen-reader label");
  assert.doesNotMatch(voice, /\.webp|\.png|public\/voices\/avatars/, "no photo assets in the picker");
  // Picker stays atomic: language chips filter the rows and choosing a voice
  // sets its language, so the two never disagree.
  assert.match(voice, /Spoken language/, "language chips stay labelled");
  assert.match(voice, /voiceForLanguage/, "language change stays atomic");
  assert.match(voice, /prefers-reduced-motion/, "carousel scroll stays reduced-motion aware");
  // Wired through the shared conversation section, not a second picker.
  assert.match(bodies, /ConversationPicker/, "personality step keeps the shared picker");
});

test("tag editing and form controls converge on the single token set", () => {
  const tag = readRepo("components/wizard/tag-field.tsx");
  const input = readRepo("components/ui/input.tsx");
  // Tag field: badge plus input-group idiom — pills inside the box with an
  // inline composer, suggestions above, count plus reserved error slot below.
  assert.match(tag, /<Badge/, "selected pills stay badges");
  assert.match(tag, /<InputGroup/, "composer stays the input-group idiom");
  assert.match(tag, /<InputGroupInput/, "composer input stays the group input");
  assert.match(tag, /Suggestions/, "suggestions stay above the box");
  assert.match(tag, /min-h-5/, "error slot stays reserved so errors never shift layout");
  assert.match(tag, /aria-invalid/, "composer stays announced");
  assert.match(tag, /commitPending/, "step navigation stays commit-first");
  // Single token set lives in the primitives: base height, standard radius,
  // input border, base-to-small type, focus-only ring, disabled parity.
  assert.match(input, /h-8/, "controls stay on the base height");
  assert.match(input, /rounded-lg/, "controls stay on the standard radius");
  assert.match(input, /border-input/, "controls stay on the input border");
  assert.match(input, /md:text-sm/, "controls stay base-to-small");
  assert.match(input, /ring-ring\/50/, "focus stays the shared ring");
  // No per-form geometry overrides outside the documented tag-box exception.
  assert.doesNotMatch(tag, /CONTROL/, "no per-form geometry overrides");
  const bodies = readRepo("components/agent-wizard/wizard-step-bodies.tsx");
  assert.doesNotMatch(bodies, /CONTROL/, "no per-form geometry overrides in step bodies");
  const wizard = readRepo("app/(dashboard)/agents/new/page.tsx");
  assert.doesNotMatch(wizard, /CONTROL/, "no per-form geometry overrides in the wizard page");
});
