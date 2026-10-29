/**
 * The persona-neutral quality floor (voice-parity ticket 66, W4).
 *
 * ── What this is ──────────────────────────────────────────────────────────
 * The five promises every agent makes about *how* it talks, regardless of
 * persona: short replies, steering instead of obeying a passing remark, no
 * corporate filler, never narrating a tool call, and numbers and addresses
 * read whole. The demo already talked by these rules; ticket 67 makes them a
 * guarantee on every stored body, tenant or demo, in every Locale that has a
 * rendering of them.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 * Not a persona. No tenant mission, house rule, business flow, or Demo
 * scenario belongs here — those compose *on top* through `composeAgentRules`
 * and never leak back into the floor. Keeping the split visible is what lets
 * one body builder serve both personas without forking the rules.
 *
 * ── Rendering later ───────────────────────────────────────────────────────
 * The floor's *meaning* is the set of ids; the English text below is one
 * rendering of them, not the owner of meaning. A `QualityFloorRendering` is a
 * complete `Record<QualityFloorId, string>`, so a Locale adds a file of its own
 * and ticket 49/50 can report a missing key as a visible hole. There is no
 * silent English fallback: `composeQualityFloor` refuses a rendering that is
 * missing or blank for any guarantee, and `qualityFloorFor` returns `null` for
 * a Locale that has not rendered the floor at all.
 */

/** The five guarantees, in the order they appear in the prompt. */
export const QUALITY_FLOOR_IDS = [
  "brevity",
  "steering",
  "no-corporate-filler",
  "no-tool-narration",
  "read-whole",
] as const;

export type QualityFloorId = (typeof QUALITY_FLOOR_IDS)[number];

/**
 * One Locale's rendering of every guarantee. The type is the completeness
 * contract: all five keys, exactly one rendering each.
 */
export type QualityFloorRendering = Readonly<Record<QualityFloorId, string>>;

/**
 * The canonical English rendering for now. Wording follows what the demo has
 * actually said on calls (see `compile.ts`); it names no persona, tenant,
 * business or Demo scenario.
 */
export const EN_QUALITY_FLOOR: QualityFloorRendering = Object.freeze({
  brevity:
    "Keep every reply short: one or two sentences, and never more than the caller needs. Match their length — a short question gets a short answer.",
  steering:
    "A passing remark is not an instruction. Acknowledge it in a few words, then steer back to what you are there to do; never abandon the task to follow it.",
  "no-corporate-filler":
    'Talk like a person, not a service desk. Contractions, plain words and the occasional incomplete sentence are fine. Never say "Thank you for that feedback", "I will pass that along", "I appreciate you sharing that" or "As an AI", and never open with a preamble.',
  "no-tool-narration":
    "Never narrate a tool call: its name, its arguments and its mechanics are not speech. Say what you are doing in a few plain words if it helps, but never read out the mechanics or claim an outcome you do not have yet.",
  "read-whole":
    "Read numbers and addresses whole: say a number as one number and an address in full, never piece by piece. If the caller needs one repeated, repeat the whole thing.",
} satisfies Record<QualityFloorId, string>);

/**
 * Compose one Locale's floor into a prompt block. Pure: the rendering goes in,
 * the same text comes out, and every guarantee appears exactly once, in
 * `QUALITY_FLOOR_IDS` order.
 *
 * A missing or blank rendering throws instead of composing a silent hole: the
 * floor is a guarantee, so an incomplete rendering is a bug, not a shorter
 * prompt.
 */
export function composeQualityFloor(
  rendering: QualityFloorRendering = EN_QUALITY_FLOOR,
): string {
  return QUALITY_FLOOR_IDS.map((id) => {
    const text = rendering[id];
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error(
        `Quality floor is missing a rendering for "${id}"; every guarantee must be rendered in the call's Locale.`,
      );
    }
    return text.trim();
  }).join("\n");
}

/**
 * The floor renderings registered per Locale. English is the first rendering,
 * not the fallback: a Locale that is not here is a hole (ticket 49/50 report
 * it), never a silent English substitution. Until those renderings land the
 * floor is therefore applied only to a Locale that has one (ticket 66 note 4,
 * carried into ticket 67) — a non-English prompt is not given English rules.
 */
export const QUALITY_FLOOR_RENDERINGS: Readonly<
  Record<string, QualityFloorRendering>
> = Object.freeze({ en: EN_QUALITY_FLOOR });

/**
 * The floor's rendering for a Locale, or `null` when that Locale has not
 * rendered it. `null` is a visible hole, not a reason to reach for English.
 */
export function qualityFloorFor(locale: string): QualityFloorRendering | null {
  return QUALITY_FLOOR_RENDERINGS[locale] ?? null;
}

/** The persona content that composes on top of the floor. */
export type AgentRuleBlocks = {
  /**
   * The floor's rendering; defaults to the canonical English one. `null` means
   * the Locale has no rendering yet, so the floor is omitted (a hole) rather
   * than replaced with English.
   */
  readonly floor?: QualityFloorRendering | null;
  /** Who the agent says it is; the first persona block after the floor. */
  readonly identity?: string | null;
  /** The agent's mission: demo's or tenant's, appended after the identity. */
  readonly mission?: string | null;
  /** A tenant's own house rules, appended last. */
  readonly houseRules?: string | null;
};

/**
 * Compose the floor with the persona content a caller owns — an identity, a
 * mission and optional house rules. The floor always comes first and is never
 * rewritten; persona content is only appended.
 *
 * This is the seam ticket 67 uses: every body in a Locale with a rendering gets
 * the floor, and a tenant's mission and house rules go on top. Empty blocks add
 * no section.
 */
export function composeAgentRules(blocks: AgentRuleBlocks = {}): string {
  const floor =
    blocks.floor === null
      ? null
      : composeQualityFloor(blocks.floor ?? EN_QUALITY_FLOOR);
  return [
    floor,
    blocks.identity?.trim(),
    blocks.mission?.trim(),
    blocks.houseRules?.trim(),
  ]
    .filter((block): block is string => typeof block === "string" && block.length > 0)
    .join("\n\n");
}

/**
 * Prove a built prompt carries the floor exactly once, as its first section,
 * before any persona content (voice-parity ticket 67).
 *
 * The floor is a guarantee, not a prompt section a caller may drop: a body
 * without it, with a copy appended by persona content, or with it buried below
 * the identity is a bug. Callers compose through `composeAgentRules` /
 * `compileSystemPrompt`; this assertion is the runtime half that a hand-built
 * body (or a future builder) still has to pass. Ticket 68 reuses it to prove a
 * tenant body's mechanics match the demo's.
 */
export function assertPromptCarriesQualityFloor(
  prompt: string,
  rendering: QualityFloorRendering = EN_QUALITY_FLOOR,
): void {
  const floor = composeQualityFloor(rendering);

  // Name the missing guarantee first, so a body that lost one reads as "brevity
  // is missing" rather than as a generic absent block.
  const missing = QUALITY_FLOOR_IDS.filter(
    (id) => !prompt.includes(rendering[id].trim()),
  );
  if (missing.length > 0) {
    throw new Error(
      `Agent system prompt is missing the quality floor guarantee(s) ${missing
        .map((id) => `"${id}"`)
        .join(", ")}; every agent carries all five.`,
    );
  }

  const blocks = prompt.split(floor).length - 1;
  if (blocks > 1) {
    throw new Error(
      `Agent system prompt carries the quality floor ${blocks} times; it appears exactly once.`,
    );
  }
  if (blocks === 0 || !prompt.startsWith(floor)) {
    throw new Error(
      "Agent system prompt must open with the quality floor; brevity is front-loaded.",
    );
  }

  for (const id of QUALITY_FLOOR_IDS) {
    const guarantee = rendering[id].trim();
    const copies = prompt.split(guarantee).length - 1;
    if (copies !== 1) {
      throw new Error(
        `Quality floor guarantee "${id}" appears ${copies} times in the agent system prompt; every guarantee appears exactly once.`,
      );
    }
  }
}
