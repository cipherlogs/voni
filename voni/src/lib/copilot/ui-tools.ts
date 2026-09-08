/** Screen tools share the production bus with the wizard and durable jobs. */
import { z } from 'zod';
import { catalogPage, type CatalogQuery, type CatalogElement } from './element-catalog';
import { cleanText, harvestCatalog, readableContent, resolveByIdentity, resolveTapInput, summarizeFill, summarizeTap, type HarvestNode, type HarvestedCatalog, type Queryable } from './ui-actuation';
import { ExecutorFailure, type BusContext, type BusToolResult, type RegisteredTool, type TargetSnapshot } from './bus';
import { SETTINGS_TABS_MANIFEST } from './app-manifest';

type Scope = { route: string; registration: number };
type Snapshot = { id: string; context: Scope; harvested: HarvestedCatalog };
type Propose = (input: { target: { kind: string; id: string }; payload: unknown; executor: string; summary: string; keyPhrases: string[] }, ctx: BusContext) => { proposal_id: string; summary: string };
const failure = (error: string, retryable = false): BusToolResult => ({ ok: false, error, retryable });
const success = (data: Record<string, unknown>): BusToolResult => ({ ok: true, data });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function internalDestination(href: string): boolean { return /^\/(?!\/)/.test(href) && !/[\\\u0000-\u0020]/.test(href); }

export class ScreenTools {
  private sequence = 0;
  private namespace = crypto.randomUUID().slice(0, 8);
  private snapshot: Snapshot | null = null;
  readonly targets = new Map<string, () => TargetSnapshot | null>();
  constructor(private deps: {
    root: () => Queryable;
    context: () => BusContext;
    brief: () => string;
    propose: Propose;
    navigate: (destination: string) => Promise<BusToolResult>;
    wait?: (ms: number) => Promise<void>;
  }) {}
  invalidate() { this.snapshot = null; this.targets.clear(); }
  private sameScope(scope: Scope) { const live = this.deps.context(); return scope.route === live.route && scope.registration === live.registration; }
  read(input: CatalogQuery = {}): BusToolResult {
    if (input.continuation) {
      if (!this.snapshot || !this.sameScope(this.snapshot.context)) return failure('Stale continuation. Call ui_read_screen again.', true);
      if (harvestCatalog(this.deps.root()).scope !== this.snapshot.harvested.scope) return failure('The dialog scope changed. Read the screen again.', true);
    } else {
      const id = `s${this.namespace}-${++this.sequence}`;
      this.snapshot = { id, context: { route: this.deps.context().route, registration: this.deps.context().registration }, harvested: harvestCatalog(this.deps.root(), { snapshot: id, version: this.sequence }) };
    }
    const snapshot = this.snapshot!;
    try {
      return success({ route: snapshot.context.route, registration: snapshot.context.registration, brief: this.deps.brief(), content: readableContent(this.deps.root()), activeScope: snapshot.harvested.scope, ...catalogPage(snapshot.harvested.catalog, snapshot.id, input) });
    } catch (error) { return failure((error as Error).message, true); }
  }
  private resolve(ref: string): { element: CatalogElement; node: HarvestNode; snapshot: Snapshot } | BusToolResult {
    const snapshot = this.snapshot;
    if (!snapshot || !this.sameScope(snapshot.context)) return failure('Read the screen again for current references.', true);
    const resolved = resolveTapInput(snapshot.harvested.catalog, ref);
    if (resolved.status === 'disambiguate') return failure(resolved.prompt);
    if (resolved.status !== 'resolved') return failure('That reference is stale. Call ui_read_screen again.', true);
    const element = resolved.element;
    const original = snapshot.harvested.nodes.find((n) => n.identity === element.identity)!;
    const live = resolveByIdentity(this.deps.root(), element.identity);
    if (!live || live.fingerprint !== original.fingerprint) return failure('That control changed or was replaced. Read the screen again; a change needs a new proposal and confirmation.', true);
    if (live.disabled) return failure(`"${element.label}" is disabled.`);
    if (live.source.getAttribute("data-copilot-manual") !== null) return failure("This control requires independent user input. Use confirm_proposal only after observed user assent.");
    if (live.secret) return failure('Use this private field manually. Credential values are not available to voice.');
    return { element, node: live, snapshot };
  }
  async act(action: 'tap' | 'fill' | 'select' | 'scroll', ref: string, value?: string): Promise<BusToolResult> {
    const resolved = this.resolve(ref);
    if ('ok' in resolved) return resolved;
    const { element, node, snapshot } = resolved;
    if (action === 'scroll' || node.role === 'upload') {
      node.reveal();
      return success({ accepted: true, completed: true, revealed: node.label, ...(node.role === 'upload' ? { manualFileSelection: true, next: 'Select the file manually. Then read the screen to validate it and propose the import. Voice cannot choose a local path.' } : {}) });
    }
    if (action === 'fill' && !node.fillable) return failure('That control does not accept text. Open a selection control, read its options, then use ui_select.');
    if (action === 'select' && !['select', 'option', 'radio', 'checkbox', 'switch', 'menuitemradio', 'menuitemcheckbox'].includes(node.role)) return failure('Open the selection control, read its options, then select an option reference.');
    if (action === 'select' && node.role !== 'select' && value !== undefined) return failure('Only native selects accept a value. Read the current state, then choose or toggle the returned option reference without a value.');
    if ((action === 'fill' || node.role === 'select') && typeof value !== 'string') return failure('Supply a value, including an empty string to clear the field.');
    if (node.role === 'select') {
      const options = node.options.filter((o) => o.value === value || o.label.toLowerCase() === value?.toLowerCase());
      if (options.length !== 1 || options[0].disabled) return failure('Choose one enabled option returned by ui_read_screen.');
      value = options[0].value;
    }
    if (node.href && !internalDestination(node.href)) return failure('I only open screens inside Voni.');
    const direct = action === 'tap' ? element.disposition === 'direct' : node.effect === 'view';
    const payload = { identity: node.identity, fingerprint: node.fingerprint, scope: snapshot.context, action, value };
    if (direct) return this.execute(payload);
    const targetId = `${snapshot.id}:${node.identity}`;
    this.targets.set(`ui-control:${targetId}`, () => {
      if (!this.sameScope(snapshot.context)) return null;
      const current = resolveByIdentity(this.deps.root(), node.identity);
      return current ? { value: current.fingerprint, version: current.fingerprint } : null;
    });
    const summary = action === 'fill' || node.role === 'select' ? summarizeFill(element, value!) : summarizeTap(element);
    const ctx = this.deps.context();
    ctx.targets.set(`ui-control:${targetId}`, this.targets.get(`ui-control:${targetId}`)!);
    return success({ ...this.deps.propose({ target: { kind: 'ui-control', id: targetId }, payload, executor: 'ui_control_exec', summary, keyPhrases: [summary] }, ctx), next: 'Read the summary back verbatim. Wait for independent yes or Apply before confirm_proposal.' });
  }
  private async execute(payload: { identity: string; fingerprint: string; scope: Scope; action: string; value?: string }): Promise<BusToolResult> {
    const node = resolveByIdentity(this.deps.root(), payload.identity);
    if (!this.sameScope(payload.scope) || !node || node.fingerprint !== payload.fingerprint || node.disabled || node.secret) return failure('The target changed. Read the screen and make a new proposal.', true);
    if (node.href) {
      if (!internalDestination(node.href)) return failure('I only open screens inside Voni.');
      return this.deps.navigate(node.href);
    }
    const before = node.state;
    const beforeScope = harvestCatalog(this.deps.root()).scope;
    const changedValue = payload.action === 'fill' || node.role === 'select';
    const dispatched = changedValue ? node.setValue?.(payload.value ?? '') : node.activate();
    if (!dispatched) return failure('The control did not accept the action.', true);
    // Dispatch is acceptance. Only an observable value/tab/dialog state proves completion.
    for (let i = 0; i < 8; i++) {
      await (this.deps.wait ?? pause)(50);
      const current = resolveByIdentity(this.deps.root(), node.identity);
      const viewClosed = node.effect === 'view' && harvestCatalog(this.deps.root()).scope !== beforeScope;
      const stepChanged = node.effect === 'view' && Boolean(current && (current.state.current !== before.current || current.state.pressed !== before.pressed || current.state.sort !== before.sort));
      const navigationCompleted = node.effect === 'navigation' && this.deps.context().registration !== payload.scope.registration;
      const completed = viewClosed || stepChanged || navigationCompleted || (changedValue ? current?.value === payload.value :
        node.role === 'tab' ? current?.state.selected === 'true' :
        ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(node.role) ? Boolean(current && current.state.checked !== before.checked) :
        node.role === 'option' ? current?.state.selected === 'true' || current?.state.selected === true || Boolean(node.selectionOwner && [node.label, node.value].includes(cleanText(node.selectionOwner))) :
        node.expanded !== undefined ? Boolean(current && current.expanded !== node.expanded) : false);

      if (completed) return success({ accepted: true, completed: true, control: node.label, state: current?.state });
    }
    return success({ accepted: true, completed: false, control: node.label, next: 'The action was accepted. Read the screen or check the job status to verify the result. Do not repeat a mutation.' });
  }
  async settingsTab(tab: string): Promise<BusToolResult> {
    const allowed = SETTINGS_TABS_MANIFEST.find((t) => t.value === tab || t.label.toLowerCase() === tab.toLowerCase());
    if (!allowed) return failure('Unknown settings tab.');
    if (this.deps.context().route !== '/settings') {
      const result = await this.deps.navigate('/settings');
      if (!result.ok || !result.data.completed) return result;
    }
    this.read();
    const elements = this.snapshot!.harvested.catalog.elements.filter((e) => e.role === 'tab' && e.label === allowed.label);
    if (elements.length !== 1) return failure('That settings tab is not available to your account.');
    return this.act('tap', elements[0].ref);
  }
  tools(): RegisteredTool[] {
    const common = { effect: { mutates: false, scope: 'screen', reversible: true }, routes: '*' as const, mode: 'interactive' as const, listed: true, executor: null };
    const readSchema = z.object({ scope: z.string().optional(), query: z.string().max(200).optional(), continuation: z.string().max(2000).optional() });
    const refSchema = z.object({ ref: z.string().min(1) });
    const fillSchema = refSchema.extend({ value: z.string().max(10000) });
    const selectSchema = refSchema.extend({ value: z.string().max(10000).optional() });
    const definition = (name: string, description: string, schema: z.ZodType, run: RegisteredTool['run']): RegisteredTool => ({ ...common, name, description, schema, parameters: z.toJSONSchema(schema) as Record<string, unknown>, run });
    return [
      definition('ui_read_screen', 'Read visible page content and controls, including offscreen controls and their state. Returns at most 60, total, scopes and a continuation token. Reuse scope/query with continuation; a new read invalidates old references.', readSchema, async (args) => this.read(args as CatalogQuery)),
      definition('ui_tap', 'Tap a snapshot reference from ui_read_screen. View actions apply immediately. Other actions propose; read back verbatim and wait for yes or Apply. Upload only reveals manual file selection.', refSchema, async (args) => this.act('tap', (args as { ref: string }).ref)),
      definition('ui_fill', 'Fill a snapshot field reference. Explicit view filters/search apply immediately. Form edits propose and need verbatim readback then yes or Apply. Never supply credentials or local file paths.', fillSchema, async (args) => { const a = args as { ref: string; value: string }; return this.act('fill', a.ref, a.value); }),
      definition('ui_select', 'Choose a native option by its value/label, or an exposed Base UI option by reference. Open the trigger and read options first. Persisted selections require confirmation; explicit view filters apply immediately.', selectSchema, async (args) => { const a = args as { ref: string; value?: string }; return this.act('select', a.ref, a.value); }),
      definition('ui_scroll', 'Scroll a returned control into view. Does not activate it or change its value.', refSchema, async (args) => this.act('scroll', (args as { ref: string }).ref)),
      definition('ui_settings_tab', 'Open a named settings tab. Only tabs visible to the signed-in account are available.', z.object({ tab: z.string() }), async (args) => this.settingsTab((args as { tab: string }).tab)),
      { ...common, name: 'ui_control_exec', description: 'Internal confirmed control executor.', parameters: {}, schema: z.unknown(), listed: false, effect: { mutates: true, scope: 'screen', reversible: false }, run: null, executor: async (payload) => {
        const result = await this.execute(payload as Parameters<ScreenTools['execute']>[0]);
        if (!result.ok) throw new ExecutorFailure(result.error, result.retryable);
        return { result: result.data };
      } },
    ];
  }
}
