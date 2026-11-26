/**
 * How a click producer chooses the next target URL.
 *
 * Two modes, one name each, shared by everything that has to agree about them:
 *
 *   - random — uniform, independent per click, with replacement. Any active
 *     target has equal odds on every click, so one target can repeat and
 *     another may wait. This is what a new script is built with.
 *   - rotate — every target once per shuffled pass, then the bag refills. This
 *     is what every script built before this module existed did, because the
 *     script drew from a shuffle bag.
 *
 * The mode is one stored setting (`email_settings.target_selection`), chosen
 * once on `/email` and read by every producer: the Grafana script's draw, the
 * GitHub dispatch's input, the one-off click and the burst. The script still
 * carries a `TARGET_SELECTION` marker, but only as a copy of that setting — the
 * rebuild writes the setting into it, and a copy left behind by an older script
 * can never override the setting (see `resolveTargetSelection`).
 *
 * `TARGET_SELECTION_LEGACY` is what a script with no marker does: every such
 * script rotates. That is also what the console reports until the setting is
 * written for the first time, so an existing check is described truthfully
 * rather than flipped to a default nobody chose.
 */

export type TargetSelection = "random" | "rotate";

/** What `buildCheckScript` emits when the caller names no mode. */
export const TARGET_SELECTION_DEFAULT: TargetSelection = "random";

/** One sentence for a mode, used by the panel's save messages. */
export function describeTargetSelection(selection: TargetSelection): string {
  return selection === "random"
    ? "draw each click's target at random"
    : "rotate through every active target once per pass";
}

/** What an unmarked (pre-setting) script does, so the panel shows the truth. */
export const TARGET_SELECTION_LEGACY: TargetSelection = "rotate";

/** Operator-facing names, one per mode, used by the panel and its messages. */
export const TARGET_SELECTION_LABELS: Record<TargetSelection, string> = {
  random: "Random",
  rotate: "Rotate through all",
};

/** What the panel's switch says under each mode. */
export const TARGET_SELECTION_DESCRIPTIONS: Record<TargetSelection, string> = {
  random:
    "Every click picks any active target with equal odds. A target can repeat, and another may wait.",
  rotate:
    "Every pass visits every active target once, in a shuffled order, then starts a new pass.",
};

export function isTargetSelection(value: unknown): value is TargetSelection {
  return value === "random" || value === "rotate";
}

/**
 * Strict parse for a submitted form value. Missing or unrecognised is `null`,
 * and the caller refuses rather than guessing: a request with no mode must not
 * silently flip the live check to the default.
 */
export function parseTargetSelection(value: unknown): TargetSelection | null {
  return isTargetSelection(value) ? value : null;
}

/**
 * Which of two answers wins: the stored setting, or what a saved script says.
 *
 * The setting is the operator's choice, so it wins every time — a script that
 * still carries another mode is a cache, and a stale cache must never override
 * a decision the page recorded. `null` means nobody has chosen yet (the column
 * is nullable on purpose), and then the script's own mode is the truth, which
 * is how an existing check keeps behaving and reporting exactly as it did
 * before the setting existed.
 */
export function resolveTargetSelection(
  setting: TargetSelection | null,
  storedScript: TargetSelection | null,
): TargetSelection {
  return setting ?? storedScript ?? TARGET_SELECTION_LEGACY;
}

/**
 * The marker a stored script actually carries, or `null` when it predates the
 * setting.
 *
 * Two different questions, two readers, on purpose:
 *
 *   - `readStoredTargetSelection` answers "what does the saved script itself
 *     carry?" `null` is "it predates the setting", which is the one case where
 *     a producer still has to consult the script at all — see
 *     `currentRotation` in `./rotation`.
 *   - `readTargetSelection` answers "what will this script do?" An unmarked
 *     script rotates, which is what a reader of the live behaviour needs to
 *     know.
 */
export function readStoredTargetSelection(
  script: string,
): TargetSelection | null {
  const match = /const TARGET_SELECTION = "(random|rotate)";/.exec(script);
  return isTargetSelection(match?.[1]) ? (match[1] as TargetSelection) : null;
}

/**
 * The mode a stored script runs with. Mirrors `readClicksPerRun`: one constant,
 * read out of the text rather than assumed, with a fallback that describes what
 * a script without the marker actually does.
 */
export function readTargetSelection(script: string): TargetSelection {
  return readStoredTargetSelection(script) ?? TARGET_SELECTION_LEGACY;
}

/**
 * The next target for a one-off click, from the subset the operator ticked.
 *
 * `random` is the same uniform draw the k6 script's random mode makes. `rotate`
 * takes the entry whose last visit is oldest — an entry never seen wins, ties
 * keep the list's own order — so repeated presses walk the selected list.
 * `lastClickedAt` is keyed by base target URL (`baseTargetUrl`), in epoch
 * milliseconds; `random` is injectable so a test can pin the draw.
 *
 * Callers refuse an empty list before calling; throwing here is the backstop for
 * a caller that forgot, because an empty draw would otherwise become `undefined`
 * and then a request to the string "undefined".
 */
export function pickTarget(
  items: readonly string[],
  selection: TargetSelection,
  lastClickedAt: ReadonlyMap<string, number> = new Map(),
  random: () => number = Math.random,
): string {
  if (items.length === 0) {
    throw new RangeError("pickTarget needs at least one target.");
  }

  if (selection === "random") {
    return items[Math.floor(random() * items.length)]!;
  }

  let best = items[0]!;
  let bestAt = lastClickedAt.get(best) ?? Number.NEGATIVE_INFINITY;
  for (const item of items.slice(1)) {
    const at = lastClickedAt.get(item) ?? Number.NEGATIVE_INFINITY;
    if (at < bestAt) {
      best = item;
      bestAt = at;
    }
  }
  return best;
}
