/**
 * Live element catalog: the addressing layer that lets voice operate any
 * screen. A harvest pass turns visible interactive elements into numbered
 * snapshot refs (snapshot:e1..eN); the model taps/fills by ref, and duplicate labels resolve
 * by spoken ordinal ("second Delete").
 *
 * Pure — no DOM here. Harvesting lives in ui-actuation.ts against a minimal
 * interface so this stays unit-testable under node:test (no jsdom).
 */

export type ControlEffect = "view" | "navigation" | "mutation" | "unknown";
export type CatalogInput = { role: string; label: string; identity?: string; state?: Record<string, unknown>; scope?: string; effect?: ControlEffect };

export type TapDisposition = "direct" | "propose";

export type CatalogElement = {
  ref: string;
  identity: string;
  state: Record<string, unknown>;
  scope: string;
  effect: ControlEffect;
  role: string;
  label: string;
  /** 1-based position among same role+label; null when the label is unique. */
  ordinal: { index: number; of: number } | null;
  disposition: TapDisposition;
};

export type ElementCatalog = {
  version: number;
  elements: CatalogElement[];
  truncated: boolean;
};

/** Token budget guard: refs stay short and the model list stays scannable. */
export const MAX_CATALOG_CONTROLS = 60;

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Known navigation and explicitly annotated view actions run directly.
 * Everything else proposes first so the confirm gate sees every data change.
 * Unknown roles fail closed to propose.
 */
export function classifyControl(
  role: string,
  attrs?: { expanded?: boolean; effect?: ControlEffect },
): TapDisposition {
  const normalized = role.trim().toLowerCase();
  if (attrs?.effect === "mutation") return "propose";
  if (attrs?.effect === "view" || attrs?.effect === "navigation") return "direct";
  if (["tab", "link", "combobox", "upload"].includes(normalized)) return "direct";
  return "propose";
}

export function buildCatalog(
  items: CatalogInput[],
  opts?: { version?: number; max?: number; snapshot?: string },
): ElementCatalog {
  // Keep all controls. Only catalogPage applies the response budget.
  void opts?.max;
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = `${item.role.trim().toLowerCase()}::${normalizeLabel(item.label)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const elements: CatalogElement[] = [];
  for (const item of items) {
    const role = item.role.trim().toLowerCase();
    const label = item.label.trim().replace(/\s+/g, " ");
    const key = `${role}::${normalizeLabel(item.label)}`;
    const of = counts.get(key) ?? 1;
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    elements.push({
      ref: `${opts?.snapshot ? `${opts.snapshot}:` : ""}e${elements.length + 1}`,
      identity: item.identity ?? `${opts?.snapshot ?? "catalog"}:item-${elements.length + 1}`,
      state: item.state ?? {},
      scope: item.scope ?? "page",
      effect: item.effect ?? "unknown",
      role,
      label,
      ordinal: of > 1 ? { index, of } : null,
      disposition: classifyControl(role, { effect: item.effect }),
    });
  }
  return {
    version: opts?.version ?? 1,
    elements,
    truncated: false,
  };
}

export function resolveRef(
  catalog: ElementCatalog,
  ref: string,
): CatalogElement | null {
  return catalog.elements.find((e) => e.ref === ref.trim().toLowerCase()) ?? null;
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/**
 * Split a spoken reference into an optional leading ordinal and the label:
 * "second delete" -> {2, "delete"}; "2nd delete", "#3 save", "3 save" likewise.
 * Bare labels return a null ordinal.
 */
export function parseSpokenRef(spoken: string): {
  ordinal: number | null;
  label: string;
} {
  const cleaned = spoken.trim().replace(/\s+/g, " ");
  const word = /^([a-z]+)\s+(.+)$/.exec(cleaned.toLowerCase());
  if (word) {
    const ordinal = ORDINAL_WORDS[word[1]!];
    if (ordinal !== undefined) return { ordinal, label: word[2]!.trim() };
  }
  const digit = /^(?:#)?(\d+)(?:st|nd|rd|th)?\s+(.+)$/.exec(cleaned.toLowerCase());
  if (digit) return { ordinal: Number(digit[1]), label: digit[2]!.trim() };
  return { ordinal: null, label: normalizeLabel(cleaned) };
}

export type LabelMatch =
  | { status: "found"; element: CatalogElement }
  | { status: "missing" }
  | { status: "ambiguous"; options: CatalogElement[] };

export function findByLabel(
  catalog: ElementCatalog,
  spoken: string,
): LabelMatch {
  const exact = catalog.elements.filter((e) => normalizeLabel(e.label) === normalizeLabel(spoken));
  if (exact.length === 1) return { status: "found", element: exact[0] };
  if (exact.length > 1) return { status: "ambiguous", options: exact.slice(0, 5) };
  const { ordinal, label } = parseSpokenRef(spoken);
  const candidates = catalog.elements.filter(
    (e) => normalizeLabel(e.label) === normalizeLabel(label),
  );
  if (candidates.length === 0) return { status: "missing" };
  if (ordinal !== null) {
    const picked = candidates[ordinal - 1];
    return picked ? { status: "found", element: picked } : { status: "missing" };
  }
  if (candidates.length === 1) return { status: "found", element: candidates[0]! };
  return { status: "ambiguous", options: candidates.slice(0, 5) };
}

/** Stable identity for proposal target readers (re-resolved live at settle). */
export function elementIdentity(element: CatalogElement): string {
  return element.identity;
}

export function formatCatalogForModel(catalog: ElementCatalog): string {
  const lines = catalog.elements.map((e) => {
    const ordinal = e.ordinal ? ` (${e.ordinal.index} of ${e.ordinal.of})` : "";
    const cost =
      e.disposition === "direct" ? "applies at once" : "needs confirmation";
    return `${e.ref} [${e.role}] "${e.label}"${ordinal} (${cost}) ${JSON.stringify(e.state)}`;
  });
  if (catalog.truncated) {
    lines.push(
      `More controls available. Use the continuation token or search; offscreen controls are included.`,
    );
  }
  return lines.join("\n");
}

export type CatalogQuery = { scope?: string; query?: string; continuation?: string };
export function catalogPage(catalog: ElementCatalog, snapshot: string, input: CatalogQuery = {}) {
  const scope = input.scope ?? "all";
  const query = normalizeLabel(input.query ?? "");
  const signature = encodeURIComponent(JSON.stringify([scope, query]));
  const prefix = `${snapshot}/${signature}/`;
  let offset = 0;
  if (input.continuation) {
    if (!input.continuation.startsWith(prefix)) throw new Error("Stale continuation. Read the screen again.");
    offset = Number(input.continuation.slice(prefix.length));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % MAX_CATALOG_CONTROLS !== 0) throw new Error("Invalid continuation.");
  }
  const matches = catalog.elements.filter((e) =>
    (scope === "all" || e.scope === scope) && (!query || normalizeLabel(`${e.label} ${e.role}`).includes(query)));
  if (offset > matches.length) throw new Error("Invalid continuation.");
  const elements = matches.slice(offset, offset + MAX_CATALOG_CONTROLS);
  const more = offset + elements.length < matches.length;
  return { snapshot, scope, query, total: matches.length, scopes: [...new Set(catalog.elements.map((e) => e.scope))],
    elements, controls: formatCatalogForModel({ ...catalog, elements, truncated: more }),
    continuation: more ? `${prefix}${offset + MAX_CATALOG_CONTROLS}` : null };
}
