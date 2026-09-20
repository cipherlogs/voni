import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenTools } from './ui-tools';
import { harvestCatalog, accessibleName, type HarvestSource } from './ui-actuation';
import { CopilotBus, type BusContext } from './bus';
import { ProposalStore } from './proposals';

function el(tagName: string, label: string, attrs: Record<string, string> = {}, extra: Partial<HarvestSource> = {}): HarvestSource {
  return { tagName, textContent: label, getAttribute: (name) => attrs[name] ?? null, ...extra };
}
function harness(initial: HarvestSource[]) {
  let nodes = initial;
  const root = { querySelectorAll: (selector: string) => selector === 'label' ? nodes.filter((n) => n.tagName === 'LABEL') : selector.includes('dialog') || selector === '[aria-modal="true"]' ? nodes.filter((n) => n.getAttribute('aria-modal') === 'true' || n.getAttribute('data-copilot-modal') === 'true') : nodes,
    getElementById: (id: string) => nodes.find((n) => n.getAttribute('id') === id) ?? null };
  const store = new ProposalStore(); const bus = new CopilotBus(store);
  const ctx: BusContext = { userId: 'u', organizationId: 'o', sessionId: 's', route: '/settings', registration: 1, targets: new Map() };
  const screen: ScreenTools = new ScreenTools({ root: () => root, context: () => ({ ...ctx, targets: screen.targets }), brief: () => 'A screen', wait: async () => {}, navigate: async (destination) => ({ ok: true, data: { accepted: true, completed: true, destination } }), propose: (input, live) => {
    const expected = live.targets.get(`${input.target.kind}:${input.target.id}`)!()!;
    const proposal = store.create({ ...input, ...ctx, expected }); return { proposal_id: proposal.id, summary: proposal.summary };
  } });
  for (const tool of screen.tools()) bus.register(tool);
  const read = (input = {}) => { const result = screen.read(input); assert.ok(result.ok); return result.data as { elements: Array<{ ref: string; label: string; role: string }>; total: number; continuation: string; controls: string }; };
  async function confirm(id: string) {
    const proposal = store.get(id)!; bus.recordAgentTurn('agent', proposal.summary); assert.deepEqual(store.arm(id), { ok: true });
    const live = { ...ctx, targets: screen.targets }; bus.recordVoiceTurn('user', 'yes', live); return bus.confirmProposal(id, live);
  }
  return { screen, read, confirm, ctx, bus, store, root, replace: (next: HarvestSource[]) => { nodes = next; } };
}
test('old numbered snapshots never reinterpret a new list', async () => {
  let clicks = 0; const h = harness([el('BUTTON', 'First', { 'data-copilot-effect': 'view' }, { click: () => { clicks++; } })]);
  const ref = h.read().elements[0].ref; h.read(); assert.equal((await h.screen.act('tap', ref)).ok, false); assert.equal(clicks, 0);
});
test('reordered duplicate targets remain bound; replacement and route changes fail closed', async () => {
  let a = 0, b = 0; const first = el('BUTTON', 'Delete', {}, { click: () => { a++; } }); const second = el('BUTTON', 'Delete', {}, { click: () => { b++; } });
  const h = harness([first, second]); const ref = h.read().elements[1].ref;
  h.replace([second, first]); const proposal = await h.screen.act('tap', ref); assert.ok(proposal.ok); await h.confirm(proposal.data.proposal_id as string); assert.equal(a, 0); assert.equal(b, 1);
  const next = h.read().elements[0].ref; h.replace([el('BUTTON', 'Delete'), first]); assert.equal((await h.screen.act('tap', next)).ok, false);
  const current = h.read().elements[0].ref; h.ctx.registration++; assert.equal((await h.screen.act('tap', current)).ok, false);
});
test('typed edits before confirmation conflict; rereading never reapplies', async () => {
  const input = el('INPUT', '', { 'aria-label': 'Name' }, { value: 'Old' }); const h = harness([input]);
  const result = await h.screen.act('fill', h.read().elements[0].ref, 'New'); assert.ok(result.ok);
  input.value = 'Typed'; h.read(); assert.equal((await h.confirm(result.data.proposal_id as string)).ok, false); assert.equal(input.value, 'Typed');
});
test('changed destination, effect, disabled state and removed target reject assent', async () => {
  for (const change of ['effect', 'disabled', 'removed']) {
    let clicks = 0; const attrs: Record<string, string> = {}; const button = el('BUTTON', 'Save', attrs, { click: () => { clicks++; } }); const h = harness([button]);
    const p = await h.screen.act('tap', h.read().elements[0].ref); assert.ok(p.ok);
    if (change === 'effect') attrs['data-copilot-effect'] = 'view'; if (change === 'disabled') attrs.disabled = ''; if (change === 'removed') h.replace([]);
    assert.equal((await h.confirm(p.data.proposal_id as string)).ok, false); assert.equal(clicks, 0);
  }
  const attrs = { href: '/leads' }; const h = harness([el('A', 'Leads', attrs)]); const ref = h.read().elements[0].ref; attrs.href = '//evil.example'; assert.equal((await h.screen.act('tap', ref)).ok, false);
});
test('view search applies immediately; form fields require readback and independent assent', async () => {
  const input = el('INPUT', '', { type: 'search', 'aria-label': 'Search jobs', 'data-copilot-effect': 'view' }, { value: '' }); const h = harness([input]);
  const result = await h.screen.act('fill', h.read().elements[0].ref, 'failed'); assert.ok(result.ok && result.data.completed); assert.equal(input.value, 'failed'); assert.equal(h.store.list().length, 0);
  const edit = el('INPUT', '', { 'aria-label': 'Name' }, { value: '' }); h.replace([edit]); const p = await h.screen.act('fill', h.read().elements[0].ref, 'Sara'); assert.ok(p.ok);
  assert.equal((await h.bus.confirmProposal(p.data.proposal_id as string, { ...h.ctx, targets: h.screen.targets })).ok, false); assert.equal(edit.value, '');
  assert.equal((await h.confirm(p.data.proposal_id as string)).ok, true); assert.equal(edit.value, 'Sara');
  assert.equal((await h.bus.confirmProposal(p.data.proposal_id as string, { ...h.ctx, targets: h.screen.targets })).ok, true);
});
test('native selections validate allowed options and preserve proposals', async () => {
  const options = [el('OPTION', 'Ivy', { value: 'ivy' }), el('OPTION', 'Sara', { value: 'sara' })];
  const select = el('SELECT', '', { 'aria-label': 'Voice' }, { value: 'ivy', querySelectorAll: () => options }); const h = harness([select]); const ref = h.read().elements[0].ref;
  assert.equal((await h.screen.act('select', ref, 'invented')).ok, false);
  const p = await h.screen.act('select', ref, 'Sara'); assert.ok(p.ok); assert.equal(select.value, 'ivy'); assert.equal((await h.confirm(p.data.proposal_id as string)).ok, true); assert.equal(select.value, 'sara');
});
test('upload reveals manual picker without click, paths or import; empty values can clear', async () => {
  let clicks = 0, revealed = 0; const upload = el('INPUT', '', { type: 'file', 'aria-label': 'CSV' }, { value: 'C:\\fakepath\\secret.csv', files: [{ name: 'leads.csv', size: 10, lastModified: 1 }], click: () => { clicks++; }, scrollIntoView: () => { revealed++; } });
  const h = harness([upload]); const read = h.read(); assert.doesNotMatch(read.controls, /fakepath|secret.csv/);
  const result = await h.screen.act('tap', read.elements[0].ref); assert.ok(result.ok && result.data.manualFileSelection); assert.equal(clicks, 0); assert.equal(revealed, 1);
});
test('overflow pages retain searchable offscreen controls and reject changed query tokens', () => {
  const h = harness(Array.from({ length: 137 }, (_, i) => el('BUTTON', `Action ${i}`))); const page = h.read(); assert.equal(page.total, 137); assert.equal(page.elements.length, 60);
  const next = h.read({ continuation: page.continuation }); assert.equal(next.elements.length, 60);
  assert.equal(h.screen.read({ continuation: next.continuation, query: 'Action 130' }).ok, false);
  assert.equal(h.read({ query: 'Action 130' }).elements[0].label, 'Action 130');
});
test('labels resolve referenced and associated text without decorative or secret noise', () => {
  const label = el('LABEL', 'Voice', { id: 'voice-label', for: 'voice' }); const button = el('BUTTON', 'Wrong', { 'aria-labelledby': 'voice-label', 'aria-label': 'Also wrong' }); const h = harness([label, button]);
  assert.equal(accessibleName(button, h.root), 'Voice');
  assert.equal(accessibleName(el('INPUT', '', { id: 'voice', value: 'secret' }), h.root), 'Voice');
  const secret = el('INPUT', '', { type: 'password', 'aria-label': 'API key' }, { value: 'never-return-me' }); h.replace([secret]); assert.doesNotMatch(h.read().controls, /never-return-me/);
  const svg = el('svg', 'decorative'); const text = { nodeType: 3, textContent: 'Save' }; const noisy = el('BUTTON', 'decorativeSave', {}, { childNodes: [{ ...svg, nodeType: 1 }, text] }); assert.equal(accessibleName(noisy, h.root), 'Save');
});
test('hidden ancestors are excluded, offscreen controls retained', () => {
  const hidden = el('DIV', '', { hidden: '' }); const inert = el('DIV', '', { inert: '' });
  const h = harness([el('BUTTON', 'Hidden', {}, { parentElement: hidden }), el('BUTTON', 'Inert', {}, { parentElement: inert }), el('BUTTON', 'Offscreen')]); assert.deepEqual(h.read().elements.map((e) => e.label), ['Offscreen']);
});
test('modal scope includes owned portaled options and excludes background', () => {
  const modal = el('DIV', '', { role: 'dialog', 'aria-modal': 'true' }); const trigger = el('BUTTON', 'Voice', { role: 'combobox', 'aria-controls': 'options' }, { parentElement: modal });
  const portal = el('DIV', '', { id: 'options' }); const option = el('DIV', 'Ivy', { role: 'option' }, { parentElement: portal });
  const h = harness([modal, trigger, portal, option, el('BUTTON', 'Background')]); const read = h.read(); assert.deepEqual(read.elements.map((e) => e.label), ['Voice', 'Ivy']);
  const nodes = harvestCatalog(h.root).nodes; assert.equal(nodes[1].effect, 'unknown');
});
test('click acceptance is not proof of completion; selected tabs are verified', async () => {
  const attrs = { role: 'tab', 'aria-selected': 'false' }; const h = harness([el('BUTTON', 'Details', attrs, { click: () => { attrs['aria-selected'] = 'true'; } })]);
  const result = await h.screen.act('tap', h.read().elements[0].ref); assert.ok(result.ok && result.data.completed);
  h.replace([el('BUTTON', 'Open', { 'data-copilot-effect': 'view' }, { click: () => {} })]); const accepted = await h.screen.act('tap', h.read().elements[0].ref); assert.ok(accepted.ok && accepted.data.accepted && !accepted.data.completed);
});

test('Base UI modal metadata scopes sheets without aria-modal', () => {
  const modal = el('DIV', '', { role: 'dialog', 'data-copilot-modal': 'true' });
  const h = harness([modal, el('BUTTON', 'Close', {}, { parentElement: modal }), el('BUTTON', 'Background')]);
  assert.deepEqual(h.read().elements.map((e) => e.label), ['Close']);
});
test('CSS-hidden ancestors and transparent controls are excluded', () => {
  const parent = el('DIV', '', {}, { ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'none' }) } } as unknown as HarvestSource['ownerDocument'] });
  const h = harness([el('BUTTON', 'Invisible', {}, { parentElement: parent }), el('BUTTON', 'Visible')]);
  assert.deepEqual(h.read().elements.map((e) => e.label), ['Visible']);
});
test('a synthetic tap cannot manufacture Apply assent', async () => {
  let clicked = false;
  const h = harness([el('BUTTON', 'Apply', { 'data-copilot-manual': 'independent-assent' }, { click: () => { clicked = true; } })]);
  assert.equal((await h.screen.act('tap', h.read().elements[0].ref)).ok, false);
  assert.equal(clicked, false);
});

test('option references never silently ignore an explicit requested value', async () => {
  let clicks = 0;
  const attrs = { role: 'switch', 'aria-checked': 'true' };
  const h = harness([el('BUTTON', 'Enabled', attrs, { click: () => { clicks++; attrs['aria-checked'] = 'false'; } })]);
  const ref = h.read().elements[0].ref;
  assert.equal((await h.screen.act('select', ref, 'true')).ok, false);
  assert.equal(clicks, 0);
  const proposed = await h.screen.act('select', ref);
  assert.ok(proposed.ok);
  assert.equal(clicks, 0);
  assert.equal((await h.confirm(proposed.data.proposal_id as string)).ok, true);
  assert.equal(clicks, 1);
});

test('explicit view sorting and page controls verify observable state immediately', async () => {
  const headerAttrs = { 'aria-sort': 'ascending' };
  const header = el('TH', '', headerAttrs);
  const sort = el('BUTTON', 'Sort by name', { 'data-copilot-effect': 'view' }, { parentElement: header, click: () => { headerAttrs['aria-sort'] = 'descending'; } });
  const h = harness([sort]);
  const result = await h.screen.act('tap', h.read().elements[0].ref);
  assert.ok(result.ok && result.data.completed);
  assert.equal(h.store.list().length, 0);
  const pageAttrs = { 'data-copilot-effect': 'view', 'aria-current': 'false' };
  h.replace([el('BUTTON', 'Page 2', pageAttrs, { click: () => { pageAttrs['aria-current'] = 'page'; } })]);
  const page = await h.screen.act('tap', h.read().elements[0].ref);
  assert.ok(page.ok && page.data.completed);
  assert.equal(h.store.list().length, 0);
});
test('named settings sections resolve to route navigation, unknown names are refused', async () => {
  const h = harness([]);
  for (const [tab, destination] of [
    ['account', '/settings/account'],
    ['Account', '/settings/account'],
    ['voice', '/settings/voice'],
    ['Voice copilot', '/settings/voice'],
    ['workspace', '/settings/workspace'],
    ['Workspace', '/settings/workspace'],
    ['services', '/settings/services'],
    ['Services', '/settings/services'],
    ['appearance', '/settings/appearance'],
    ['Appearance', '/settings/appearance'],
  ] as Array<[string, string]>) {
    const result = await h.screen.settingsTab(tab);
    assert.ok(result.ok, `${tab} resolves`);
    assert.equal((result.data as { destination: string }).destination, destination);
  }
  assert.equal((await h.screen.settingsTab('billing')).ok, false);
});
