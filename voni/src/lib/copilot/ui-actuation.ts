/** Injectable DOM adapter. References identify elements, never row positions. */
import { buildCatalog, elementIdentity, findByLabel, resolveRef, type CatalogElement, type ControlEffect, type ElementCatalog } from "./element-catalog";

export type HarvestSource = {
  tagName: string;
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
  parentElement?: HarvestSource | null;
  children?: Iterable<HarvestSource>;
  childNodes?: Iterable<{ nodeType: number; textContent: string | null }>;
  labels?: Iterable<HarvestSource> | null;
  value?: string;
  files?: Iterable<{ name: string; size: number; lastModified: number }> | null;
  checked?: boolean;
  selected?: boolean;
  disabled?: boolean;
  isConnected?: boolean;
  click?: () => void;
  focus?: () => void;
  scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
  dispatchEvent?: (event: Event) => boolean;
  querySelectorAll?: (selector: string) => Iterable<HarvestSource>;
  ownerDocument?: { defaultView: { getComputedStyle(el: Element): CSSStyleDeclaration } | null };
};
export type Queryable = { querySelectorAll(selector: string): Iterable<HarvestSource>; getElementById?: (id: string) => HarvestSource | null };
export type HarvestNode = {
  identity: string; source: HarvestSource; role: string; label: string; scope: string;
  effect: ControlEffect; disabled: boolean; fillable: boolean; secret: boolean;
  href: string | null; expanded: boolean | undefined; value: string | null;
  state: Record<string, unknown>; fingerprint: string;
  selectionOwner: HarvestSource | undefined;
  options: { label: string; value: string; disabled: boolean }[];
  activate: () => boolean; reveal: () => void;
  setValue: ((value: string) => boolean) | null;
};
export const HARVEST_SELECTOR = 'button,a[href],input,select,textarea,[role="tab"],[role="button"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="switch"],[role="checkbox"],[role="radio"],[role="combobox"],[role="option"],[aria-expanded]';
const instances = new WeakMap<object, number>();
let instanceSeq = 0;
function instance(el: HarvestSource): number {
  let id = instances.get(el);
  if (!id) { id = ++instanceSeq; instances.set(el, id); }
  return id;
}
function ancestors(el: HarvestSource): HarvestSource[] {
  const result: HarvestSource[] = [];
  for (let n: HarvestSource | null | undefined = el; n; n = n.parentElement) result.push(n);
  return result;
}
function attr(el: HarvestSource, name: string) { return el.getAttribute(name); }
export function isVisible(el: HarvestSource): boolean {
  return el.isConnected !== false && !ancestors(el).some((n) => {
    if (attr(n, 'hidden') !== null || attr(n, 'inert') !== null || attr(n, 'aria-hidden') === 'true' || attr(n, 'data-copilot-ignore') !== null) return true;
    const style = n.ownerDocument?.defaultView?.getComputedStyle(n as Element);
    return style?.display === 'none' || style?.opacity === '0' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.contentVisibility === 'hidden';
  });
}
function secret(el: HarvestSource): boolean {
  return ancestors(el).some((n) => attr(n, 'data-copilot-secret') !== null) || attr(el, 'type') === 'password' || /password|secret|api.?key|credential|token/i.test(`${attr(el, 'name') ?? ''} ${attr(el, 'id') ?? ''} ${attr(el, 'aria-label') ?? ''}`);
}
export function cleanText(el: HarvestSource): string {
  if (secret(el) || ['svg', 'script', 'style', 'input', 'textarea'].includes(el.tagName.toLowerCase()) || attr(el, 'aria-hidden') === 'true' || attr(el, 'data-copilot-ignore') !== null) return '';
  if (!el.childNodes) return el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
  return Array.from(el.childNodes).map((n) => n.nodeType === 3 ? n.textContent : n.nodeType === 1 ? cleanText(n as unknown as HarvestSource) : '').join(' ').replace(/\s+/g, ' ').trim();
}
export function accessibleName(el: HarvestSource, root: Queryable): string | null {
  const ids = attr(el, 'aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
  const byIds = ids.map((id) => { const n = root.getElementById?.(id); return n ? cleanText(n) : ''; }).join(' ').trim();
  const labels = Array.from(el.labels ?? []).map(cleanText).join(' ').trim();
  const id = attr(el, 'id');
  const associated = id ? Array.from(root.querySelectorAll('label')).filter((n) => attr(n, 'for') === id).map(cleanText).join(' ') : '';
  const wrapping = ancestors(el).find((n) => n.tagName.toLowerCase() === 'label');
  const name = byIds || attr(el, 'aria-label')?.trim() || labels || associated || (wrapping ? cleanText(wrapping) : '') ||
    (['submit', 'button'].includes(attr(el, 'type') ?? '') ? attr(el, 'value') : '') ||
    (!['input', 'textarea', 'select'].includes(el.tagName.toLowerCase()) ? cleanText(el) : '') || attr(el, 'placeholder') || attr(el, 'title');
  return name?.replace(/\s+/g, ' ').trim().slice(0, 160) || null;
}
function roleOf(el: HarvestSource): string | null {
  const explicit = attr(el, 'role'); if (explicit) return explicit.toLowerCase();
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button'; if (tag === 'a') return 'link';
  if (tag === 'select') return 'select'; if (tag === 'textarea') return 'textbox';
  if (tag !== 'input') return null;
  const type = attr(el, 'type') ?? 'text';
  if (type === 'hidden') return null;
  if (type === 'file') return 'upload';
  if (['radio', 'checkbox'].includes(type)) return type;
  if (['button', 'submit', 'reset'].includes(type)) return 'button';
  return type === 'search' ? 'searchbox' : 'textbox';
}
function disabled(el: HarvestSource): boolean {
  return Boolean(el.disabled) || ancestors(el).some((n) => attr(n, 'aria-disabled') === 'true' || attr(n, 'disabled') !== null || attr(n, 'data-disabled') !== null);
}
function ownerOf(el: HarvestSource, root: Queryable): HarvestSource | undefined {
  const containers = ancestors(el).map((n) => attr(n, 'id')).filter(Boolean);
  return Array.from(root.querySelectorAll('[aria-controls],[aria-owns]')).find((n) =>
    `${attr(n, 'aria-controls') ?? ''} ${attr(n, 'aria-owns') ?? ''}`.split(/\s+/).some((id) => containers.includes(id)));
}
function scopeOf(el: HarvestSource): string {
  for (const n of ancestors(el)) {
    if (attr(n, 'data-copilot-scope')) return attr(n, 'data-copilot-scope')!;
    if (['dialog', 'alertdialog'].includes(attr(n, 'role') ?? '')) return `dialog:${instance(n)}`;
    if (n.tagName.toLowerCase() === 'nav' || attr(n, 'data-slot') === 'sidebar') return 'navigation';
  }
  return 'page';
}
function effectOf(el: HarvestSource, role: string, root: Queryable): ControlEffect {
  const explicit = ancestors(el).map((n) => attr(n, 'data-copilot-effect')).find(Boolean);
  if (explicit && ['view', 'navigation', 'mutation'].includes(explicit)) return explicit as ControlEffect;
  if (role === 'option') { const owner = ownerOf(el, root); return owner ? effectOf(owner, 'selection', root) : 'unknown'; }
  if (role === 'link' || (el.tagName.toLowerCase() === 'a' && attr(el, 'href'))) return 'navigation';
  if (['tab', 'combobox', 'upload'].includes(role)) return 'view';
  return 'unknown';
}
function valueOf(el: HarvestSource) { return attr(el, 'type') === 'file' ? JSON.stringify(Array.from(el.files ?? []).map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified }))) : attr(el, 'data-copilot-value') ?? el.value ?? attr(el, 'value') ?? null; }
// Fingerprints stay in the browser. Never put credential values in snapshots.
const privateValues = new WeakMap<object, { value: string | null; version: number }>();
function privateVersion(el: HarvestSource) {
  const value = valueOf(el);
  const prev = privateValues.get(el);
  if (!prev || prev.value !== value) privateValues.set(el, { value, version: (prev?.version ?? 0) + 1 });
  return privateValues.get(el)!.version;
}
function formState(el: HarvestSource) {
  const form = ancestors(el).find((n) => n.tagName.toLowerCase() === 'form' || attr(n, 'data-copilot-form') !== null);
  return Array.from(form?.querySelectorAll?.('input,textarea,select,[role="combobox"]') ?? []).map((n) =>
    [instance(n), secret(n) ? { privateVersion: privateVersion(n) } : valueOf(n), n.checked, attr(n, 'aria-selected'), attr(n, 'aria-valuetext'), n.tagName.toLowerCase() === 'button' ? cleanText(n) : null]);
}
function toNode(el: HarvestSource, root: Queryable, scope?: string): HarvestNode | null {
  if (!isVisible(el)) return null;
  const role = roleOf(el); if (!role) return null;
  const label = accessibleName(el, root); if (!label) return null;
  const tag = el.tagName.toLowerCase(); const isSecret = secret(el);
  const fillable = !isSecret && ['textbox', 'searchbox', 'select'].includes(role) && attr(el, 'readonly') === null;
  const href = tag === 'a' ? attr(el, 'href') : null;
  const effect = effectOf(el, role, root);
  const expanded = attr(el, 'aria-expanded') === null ? undefined : attr(el, 'aria-expanded') === 'true';
  const container = ancestors(el).find((n) => attr(n, 'data-copilot-key') !== null);
  const identity = `${container ? attr(container, 'data-copilot-key') : 'element'}@${instance(el)}`;
  const nodeScope = scope ?? scopeOf(el);
  const options = tag === 'select' && !isSecret ? Array.from(el.querySelectorAll?.('option') ?? []).map((o) => ({ label: cleanText(o), value: valueOf(o) ?? '', disabled: disabled(o) })) : [];
  const value = isSecret ? null : role === "combobox" ? cleanText(el) : valueOf(el);
  const selectionOwner = role === "option" ? ownerOf(el, root) : undefined;
  const sort = ancestors(el).map((n) => attr(n, 'aria-sort')).find((s) => s !== null);
  const state = { disabled: disabled(el), ...(isSecret ? { private: true } : { value, checked: el.checked ?? attr(el, 'aria-checked'), selected: attr(el, 'aria-selected') ?? el.selected, current: attr(el, "aria-current"), pressed: attr(el, "aria-pressed"), sort, expanded, options }), ...(role === 'upload' ? { manualFileSelection: true } : {}) };
  const fingerprint = JSON.stringify({ identity, role, label, scope: nodeScope, effect, href, state, form: formState(el), formVersion: ancestors(el).map((n) => attr(n, 'data-copilot-version')).filter(Boolean), owner: role === 'option' ? (() => { const owner = ownerOf(el, root); return owner ? [instance(owner), valueOf(owner), cleanText(owner), formState(owner)] : null; })() : null });
  const reveal = () => { el.scrollIntoView?.({ block: 'center', behavior: 'instant' }); el.focus?.(); };
  return { identity, source: el, role, label, scope: nodeScope, effect, disabled: disabled(el), fillable, secret: isSecret, href, expanded, value, options, state, fingerprint, selectionOwner, reveal,
    activate: () => { if (!el.click) return false; reveal(); el.click(); return true; },
    setValue: fillable ? (next: string) => {
      if (tag === 'select' && !options.some((o) => o.value === next && !o.disabled)) return false;
      reveal();
      const ctorName = tag === 'textarea' ? 'HTMLTextAreaElement' : tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement';
      const ctor = (globalThis as Record<string, unknown>)[ctorName] as { prototype?: object } | undefined;
      const setter = ctor?.prototype ? Object.getOwnPropertyDescriptor(ctor.prototype, 'value')?.set : undefined;
      if (setter) setter.call(el, next); else el.value = next;
      el.dispatchEvent?.(new Event('input', { bubbles: true }));
      el.dispatchEvent?.(new Event('change', { bubbles: true }));
      return true;
    } : null };
}
function activeModal(root: Queryable): HarvestSource | undefined {
  return Array.from(root.querySelectorAll('[data-copilot-modal="true"],[role="dialog"][aria-modal="true"],[role="alertdialog"],dialog[open]')).filter((n) => isVisible(n) && (attr(n, 'data-copilot-modal') === 'true' || attr(n, 'aria-modal') === 'true' || attr(n, 'role') === 'alertdialog' || n.tagName.toLowerCase() === 'dialog')).at(-1);
}
export type HarvestedCatalog = { catalog: ElementCatalog; nodes: HarvestNode[]; scope: string };
export function harvestCatalog(root: Queryable, opts?: { version?: number; max?: number; snapshot?: string }): HarvestedCatalog {
  const all = [...new Set(root.querySelectorAll(HARVEST_SELECTOR))];
  const modal = activeModal(root);
  const within = (n: HarvestSource) => modal ? ancestors(n).includes(modal) : true;
  const inScope = (n: HarvestSource) => { if (within(n)) return true; const owner = ownerOf(n, root); return Boolean(owner && within(owner)); };
  const scope = modal ? `dialog:${instance(modal)}` : 'page';
  const nodes = all.filter(inScope).map((el) => toNode(el, root, modal ? scope : undefined)).filter((n): n is HarvestNode => n !== null);
  return { catalog: buildCatalog(nodes.map((n) => ({ role: n.role, label: n.label, identity: n.identity, state: n.state, scope: n.scope, effect: n.effect })), opts), nodes, scope };
}
export function resolveByIdentity(root: Queryable, identity: string): HarvestNode | null {
  const matches = harvestCatalog(root).nodes.filter((n) => n.identity === identity);
  return matches.length === 1 ? matches[0] : null;
}
export function readableContent(root: Queryable): string {
  const candidates = Array.from(root.querySelectorAll('h1,h2,h3,p,li,dt,dd,td,[role="status"],[role="alert"]'));
  const modal = activeModal(root);
  return candidates.filter((n) => isVisible(n) && (!modal || ancestors(n).includes(modal))).map(cleanText).filter(Boolean).join('\n').slice(0, 12000);
}
/** Readback wording: names the control so "yes" binds to something heard. */
export function summarizeTap(element: CatalogElement): string {  const ordinal =
    element.ordinal && element.ordinal.of > 1
      ? ` (${element.ordinal.index} of ${element.ordinal.of})`
      : "";
  return `Tap "${element.label}" (${element.role})${ordinal}`;
}

export function summarizeFill(element: CatalogElement, value: string): string {
  return `Set "${element.label}" to "${value}"`;
}

export type TapInputResolution =
  | { status: "resolved"; element: CatalogElement }
  | { status: "stale" }
  | { status: "disambiguate"; prompt: string };

/**
 * Forgiving ref resolution: exact snapshot refs first, then spoken labels
 * ("second delete"). Duplicate names without an ordinal come back as a
 * spoken disambiguation prompt, never a guess.
 */
export function resolveTapInput(
  catalog: ElementCatalog,
  raw: string,
): TapInputResolution {
  const direct = resolveRef(catalog, raw);
  if (direct) return { status: "resolved", element: direct };
  const match = findByLabel(catalog, raw);
  if (match.status === "found") return { status: "resolved", element: match.element };
  if (match.status === "ambiguous") {
    const choices = match.options
      .map((o) => {
        const ordinal = o.ordinal ? ` (${o.ordinal.index} of ${o.ordinal.of})` : "";
        return `"${o.label}"${ordinal} is ${o.ref}`;
      })
      .join("; ");
    return { status: "disambiguate", prompt: `Which one? ${choices}.` };
  }
  return { status: "stale" };
}

export { elementIdentity };
