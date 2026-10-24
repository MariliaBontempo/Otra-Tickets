// Oracle: the red X on a page section in the admin editor removes only that
// section and can always be undone.
//   1) site-overrides.js hides a removed section (data-otra-removed + hidden)
//      and keeps it in the DOM. event.html renders into sections by id, so a
//      section taken out of the DOM before the render made the render throw
//      and every section after it (prices, checkout) vanished.
//   2) The editor never offers a section X on a section holding prices,
//      checkout or Before You Go (checked against the real event.html markup).
//   3) removeSection asks first, and removed sections have a Restore control.
// Run: node scripts/check-admin-remove-section.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const overrides = fs.readFileSync(new URL('../site-overrides.js', import.meta.url), 'utf8');
const eventHtml = fs.readFileSync(new URL('../event.html', import.meta.url), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

function extractFunction(name, source) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

// ---- 1) site-overrides.js keeps removed sections in the DOM ----
{
  const apply = extractFunction('applyFieldOverrides', overrides);
  assert(/type === "remove" && field\.type === "remove"\)\s*\{[\s\S]{0,400}?applyRemoval\(el\);/.test(apply), 'remove fields must go through applyRemoval');
  assert(!/type === "remove"[\s\S]{0,80}el\.remove\(\)/.test(apply), 'remove fields must not call el.remove() directly');

  const removed = [];
  const styles = [];
  const byId = new Map();
  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (el) => { styles.push(el); byId.set(el.id, el); } },
  };
  const makeEl = (tagName, id = '') => {
    const attrs = {};
    const el = {
      tagName, id, hidden: false,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      remove: () => { removed.push(el); if (id) byId.delete(id); },
    };
    if (id) byId.set(id, el);
    return el;
  };
  const ctx = { document };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('ensureRemovedStyle', overrides) + '\n' + extractFunction('applyRemoval', overrides), ctx);

  const rates = makeEl('SECTION', 'evRatesSection');
  const hero = makeEl('SECTION');
  const footer = makeEl('FOOTER');
  const card = makeEl('DIV');
  [rates, hero, footer, card].forEach((el) => ctx.applyRemoval(el));
  ctx.applyRemoval(rates); // applied again after a render: still one element, still hidden

  assert(!removed.includes(rates) && !removed.includes(hero) && !removed.includes(footer), 'a removed section must stay in the DOM');
  assert(document.getElementById('evRatesSection') === rates, 'event.html must still find #evRatesSection after it was removed (render must not throw)');
  for (const el of [rates, hero, footer]) {
    assert(el.hidden === true && el.getAttribute('data-otra-removed') === '1', `removed ${el.tagName}${el.id ? '#' + el.id : ''} must be hidden and marked`);
  }
  assert(removed.includes(card), 'a small item like a price card is still removed outright');
  assert(styles.length === 1, 'the hide rule is injected once, got ' + styles.length);
  const rule = styles[0] ? styles[0].textContent : '';
  assert(/\[data-otra-removed\]\[data-otra-removed\]\[data-otra-removed\]\s*\{\s*display:\s*none\s*!important/.test(rule), 'removed sections must stay hidden even when the render unhides them');
}

// ---- 2) the editor never offers a section X on prices / checkout / Before You Go ----
{
  const protectedConst = (html.match(/const PROTECTED_SECTION_CONTENT = "[^"]*";/) || [''])[0];
  assert(protectedConst, 'admin must define PROTECTED_SECTION_CONTENT');
  const isProtected = extractFunction('isProtectedSection', html);
  const isRemovable = extractFunction('isRemovableSection', html);
  assert(isRemovable.includes('isProtectedSection(el)'), 'isRemovableSection must refuse protected sections');

  // Build light elements from the real event.html sections: each knows the
  // ids and classes it contains, which is all the selectors need.
  const main = eventHtml.slice(eventHtml.indexOf('<main'), eventHtml.indexOf('</main>'));
  const sections = [...main.matchAll(/<(section|footer)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => {
    const attrs = m[2];
    const body = m[3];
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1] || '';
    const cls = ((attrs.match(/\bclass="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    const innerIds = [...body.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
    const innerCls = [...body.matchAll(/\bclass="([^"]+)"/g)].flatMap((x) => x[1].split(/\s+/));
    const hasAttr = (name) => new RegExp(`\\b${name}\\b`).test(attrs);
    const test = (sel, ids, classes) => sel.split(',').map((s) => s.trim()).some((s) =>
      s.startsWith('#') ? ids.includes(s.slice(1)) : s.startsWith('.') ? classes.includes(s.slice(1)) : false);
    return {
      tagName: m[1].toUpperCase(), id,
      label: id || cls[0] || m[1],
      closest: () => null,
      hasAttribute: (name) => name === 'hidden' ? false : hasAttr(name),
      hidden: false,
      matches: (sel) => test(sel, id ? [id] : [], cls),
      querySelector: (sel) => (test(sel, innerIds, innerCls) ? {} : null),
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
      ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } },
    };
  });
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${protectedConst}\n${isProtected}\n${isRemovable}`, ctx);
  const byLabel = Object.fromEntries(sections.map((s) => [s.label, s]));
  for (const id of ['evInfoSection', 'evRatesSection', 'book', 'evTicketsSkeleton']) {
    assert(byLabel[id], `event.html should still have #${id}`);
    if (byLabel[id]) assert(ctx.isRemovableSection(byLabel[id]) === false, `#${id} must not get a section X`);
  }
  for (const id of ['story', 'evVideoSection', 'evBandSection', 'evPhotoBandSection']) {
    if (byLabel[id]) assert(ctx.isRemovableSection(byLabel[id]) === true, `#${id} should keep its section X`);
  }
  // Any section that holds prices or checkout, whatever its id.
  for (const s of sections) {
    const holdsMoney = s.querySelector('#evRates, .ev-rates, #otra-checkout-container, #evInfoGrid');
    if (holdsMoney) assert(ctx.isRemovableSection(s) === false, `section ${s.label} holds prices/checkout/info and must not be removable`);
  }
  const marked = { ...sections[0], hasAttribute: (n) => n === 'data-otra-removed' };
  assert(ctx.isRemovableSection(marked) === false, 'an already removed section must not get another X');
}

// ---- 3) confirm + restore ----
{
  const remove = extractFunction('removeSection', html);
  assert(/window\.confirm\(`Remove this \$\{noun\}/.test(remove), 'removeSection must ask "Remove this section?" first');
  assert(remove.indexOf('isProtectedSection(field.element)') > -1 && remove.indexOf('isProtectedSection(field.element)') < remove.indexOf('persistOverrideFields'), 'removeSection must refuse a protected section before saving');
  assert(/<button class="btn ghost hidden" id="restoreSectionsBtn" type="button">/.test(html), 'admin must have a Restore removed sections button');
  const keys = extractFunction('removedSectionKeys', html);
  const ctx = { currentOverride: { fields: {
    'remove:#story': { type: 'remove', value: '1' },
    'remove:main > section:nth-of-type(2)': { type: 'remove', value: '1' },
    'remove:#evRates > .ev-rate[data-otra-rate-name="VIP"]': { type: 'remove', kind: 'price-card' },
    'text:#evTitle': { type: 'text', value: 'x' },
  } } };
  ctx.currentOverride.fields['remove:#evInfoSection'] = { type: 'remove', value: '1' };
  vm.createContext(ctx);
  vm.runInContext((html.match(/const DRAFT_ONLY_REMOVE_KEYS = \[[^\]]*\];/) || [''])[0] + '\n' + keys, ctx);
  const got = ctx.removedSectionKeys();
  assert(got.length === 2 && got.includes('remove:#story') && got.includes('remove:main > section:nth-of-type(2)'), 'Restore removed sections must list section removals only, got ' + JSON.stringify(got));
  assert(/removedSectionKeys\(\)[\s\S]{0,400}delete fields\[key\]/.test(extractFunction('restoreRemovedSections', html)), 'restore must delete the remove fields');
  assert(/updateRemovedSectionControl\(\);/.test(extractFunction('fillForm', html)), 'the restore button must refresh whenever the override loads or saves');
}

// ---- 4) Before You Go: hidden on purpose only on an unpublished draft ----
{
  const lib = await import(new URL('../functions/_lib/draft-only-sections.js', import.meta.url));
  const adminKeys = (html.match(/const DRAFT_ONLY_REMOVE_KEYS = (\[[^\]]*\]);/) || [])[1];
  assert(adminKeys && JSON.stringify(JSON.parse(adminKeys)) === JSON.stringify([...lib.DRAFT_ONLY_REMOVE_KEYS]), 'admin and server must agree on the draft-only keys');
  assert(/value === "#evInfoSection" \|\| value === "main > #evInfoSection"/.test(overrides), 'site-overrides.js must know the same draft-only selectors');
  assert(/id="evInfoSection"/.test(eventHtml), 'event.html Before You Go section must keep id evInfoSection');

  const store = new Map();
  const kv = {
    get: async (key, type) => { const v = store.get(key); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
    put: async (key, v) => { store.set(key, v); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
  const draftId = 'draft-1792794492337-315e4c35';
  const pubDraftId = 'draft-1700000000000-aaaaaaaa';
  const unboundPubDraft = 'draft-1700000000001-bbbbbbbb';
  store.set(`site-event:${draftId}`, JSON.stringify({ status: 'draft', adminOnly: true, otraGuideId: '' }));
  store.set(`site-event:${pubDraftId}`, JSON.stringify({ status: 'published', publishedAt: '2026-10-01T00:00:00Z', otraGuideId: '8266', createdAt: '2026-10-01' }));
  store.set(`site-event:${unboundPubDraft}`, JSON.stringify({ status: 'draft', publishedAt: '2026-10-01T00:00:00Z' }));
  const hideFields = { 'remove:#evInfoSection': { type: 'remove', value: '1' }, 'text:#evBandText': { type: 'text', value: 'Access' } };
  store.set(`event:${draftId}`, JSON.stringify({ fields: hideFields, updatedAt: '2026-10-24T00:00:00Z' }));
  store.set(`event:${pubDraftId}`, JSON.stringify({ fields: hideFields, updatedAt: '2026-10-24T00:00:00Z' }));
  store.set(`event:${unboundPubDraft}`, JSON.stringify({ fields: hideFields, updatedAt: '2026-10-24T00:00:00Z' }));
  store.set('event:8266', JSON.stringify({ fields: { 'text:#evTitle': { type: 'text', value: 'Live' } }, pageEditsVersion: 2, updatedAt: '2026-10-01T00:00:00Z' }));

  assert(await lib.allowsDraftOnlyRemovals(kv, draftId) === true, 'an unpublished draft may hide Before You Go');
  assert(await lib.allowsDraftOnlyRemovals(kv, pubDraftId) === false, 'a published draft must not hide Before You Go');
  assert(await lib.allowsDraftOnlyRemovals(kv, unboundPubDraft) === false, 'a draft with publishedAt must not hide Before You Go');
  assert(await lib.allowsDraftOnlyRemovals(kv, '8266') === false, 'a live Otra Guide page must not hide Before You Go');
  assert(await lib.allowsDraftOnlyRemovals(kv, 'draft-prod-8266') === false, 'draft-prod ids are live pages');
  const stripped = lib.withoutDraftOnlyRemovals({ ...hideFields, 'remove:main > #evInfoSection': { type: 'remove' }, 'remove:#story': { type: 'remove' } });
  assert(!stripped['remove:#evInfoSection'] && !stripped['remove:main > #evInfoSection'] && stripped['remove:#story'] && stripped['text:#evBandText'], 'strip drops only the Before You Go hide');

  // Public endpoint, end to end with the fake KV.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const { onRequestGet } = await import(new URL('../functions/api/override.js', import.meta.url));
    const read = async (id) => {
      const resp = await onRequestGet({ request: new Request(`https://otratickets.com/api/override?id=${id}`), env: { OVERRIDES: kv } });
      const data = await resp.json();
      return data.override ? data.override.fields : null;
    };
    const draftFields = await read(draftId);
    assert(draftFields && draftFields['remove:#evInfoSection'], 'the unpublished draft page must get its Before You Go hide');
    assert(draftFields && draftFields['text:#evBandText'], 'the draft keeps its Details wording');
    const live = await read('8266');
    assert(live && !live['remove:#evInfoSection'], 'live page 8266 (merges the published draft edits) must keep Before You Go');
    assert(live && live['text:#evBandText'] && live['text:#evTitle'], 'the live page still gets the other draft edits');
    const pub = await read(pubDraftId);
    assert(pub && !pub['remove:#evInfoSection'], 'a published draft id must keep Before You Go');
    const unbound = await read(unboundPubDraft);
    assert(unbound && !unbound['remove:#evInfoSection'], 'a draft with publishedAt must keep Before You Go');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Admin API strips the hide on GET and PUT of any non unpublished-draft id.
  const adminApi = fs.readFileSync(new URL('../functions/admin/api/overrides.js', import.meta.url), 'utf8');
  const get = adminApi.slice(adminApi.indexOf('export async function onRequestGet'), adminApi.indexOf('export async function onRequestPut'));
  const put = adminApi.slice(adminApi.indexOf('export async function onRequestPut'), adminApi.indexOf('function photoSignature'));
  assert(/allowsDraftOnlyRemovals\(kv, id\)\)\) override\.fields = withoutDraftOnlyRemovals/.test(get), 'admin GET must drop the hide on live pages');
  assert(/allowsDraftOnlyRemovals\(kv, id\)\)\) override\.fields = withoutDraftOnlyRemovals[\s\S]*kv\.put\(KEY\(id\)/.test(put), 'admin PUT must drop the hide before storing a live page');

  // site-overrides.js ignores the hide on a numeric (live) page id.
  {
    const apply = extractFunction('applyFieldOverrides', overrides);
    const hidden = [];
    const els = { '#evInfoSection': { id: 'evInfoSection', tagName: 'SECTION' }, '#story': { id: 'story', tagName: 'SECTION' } };
    const run = (id) => {
      hidden.length = 0;
      const ctx = { id, document: { querySelector: (sel) => els[sel] || null }, applyRemoval: (el) => hidden.push(el.id), setTimeout: () => {}, tidyMetaLine: () => {} };
      vm.createContext(ctx);
      vm.runInContext(extractFunction('isDraftOnlySelector', overrides) + '\n' + apply, ctx);
      ctx.applyFieldOverrides({ 'remove:#evInfoSection': { type: 'remove', value: '1' }, 'remove:#story': { type: 'remove', value: '1' } });
      return [...hidden];
    };
    const onLive = run('8266');
    assert(!onLive.includes('evInfoSection') && onLive.includes('story'), 'live page must not hide Before You Go, got ' + JSON.stringify(onLive));
    const onProd = run('draft-prod-8266');
    assert(!onProd.includes('evInfoSection'), 'a draft-prod page is live and must keep Before You Go, got ' + JSON.stringify(onProd));
    const onDraft = run(draftId);
    assert(onDraft.includes('evInfoSection'), 'draft page must hide Before You Go, got ' + JSON.stringify(onDraft));
  }

  // Editor control: draft only, confirm first, never a section X.
  const can = extractFunction('canHideBeforeYouGo', html);
  const ctx = {
    isDraft: (p) => !!p && (p.isDraft || p.status === 'draft' || /^draft-/.test(p.id)),
    overrideIdForPage: (p) => p.id,
  };
  vm.createContext(ctx);
  vm.runInContext(can, ctx);
  assert(ctx.canHideBeforeYouGo({ id: draftId, isDraft: true, status: 'draft' }) === true, 'button shows on an unpublished draft');
  assert(ctx.canHideBeforeYouGo({ id: pubDraftId, isDraft: true, status: 'published' }) === false, 'no button on a published draft');
  assert(ctx.canHideBeforeYouGo({ id: unboundPubDraft, isDraft: true, status: 'draft', publishedAt: '2026' }) === false, 'no button on a draft with publishedAt');
  assert(ctx.canHideBeforeYouGo({ id: '8266', status: 'published' }) === false, 'no button on a live page');
  assert(/id="draftBeforeYouGoBtn"/.test(html), 'admin must have the Hide Before You Go on this draft button');
  const toggle = extractFunction('toggleDraftBeforeYouGo', html);
  assert(toggle.indexOf('canHideBeforeYouGo(selected)') > -1 && toggle.indexOf('window.confirm') > toggle.indexOf('canHideBeforeYouGo(selected)') && toggle.indexOf('window.confirm') < toggle.indexOf('persistOverrideFields'), 'toggle checks draft, then confirms, then saves');
  assert(/updateDraftBeforeYouGoControl\(\);/.test(extractFunction('fillForm', html)), 'the button refreshes when the override loads');
  assert(/#evInfoGrid/.test((html.match(/const PROTECTED_SECTION_CONTENT = "[^"]*";/) || [''])[0]), 'Before You Go still never gets a section X');
}

if (failures.length) {
  console.error('check-admin-remove-section FAILED:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('check-admin-remove-section OK (sections hidden not deleted, protected sections have no X, confirm + restore, Before You Go hidden only on unpublished drafts)');
