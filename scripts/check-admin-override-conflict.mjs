// Oracle: two admin editors (or two tabs) saving the same page never wipe
// each other's edits silently (Strange Bird Flight 2: Event Details text
// vanished after save while another admin was editing).
//   1) PUT /admin/api/overrides takes the version the editor loaded. When the
//      page changed since, the save is merged key by key onto the newer
//      document, and refused with 409 + "Reload" when both changed one key.
//   2) The admin client sends that version and the before values of the keys
//      it changed on every override save (pencil, red X, video, colour).
//   3) Saving the draft content modal clears an older pencil edit of the
//      section label / heading / text it changed, so the new wording shows.
// Run: node scripts/check-admin-override-conflict.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';
import { onRequestGet as adminGet, onRequestPut as adminPut } from '../functions/admin/api/overrides.js';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
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

function makeKv(records = {}) {
  const store = new Map(Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    doc(key) { const raw = store.get(key); return raw === undefined ? null : JSON.parse(raw); },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  if (String(input).endsWith('/users/user-role/')) return { ok: true, json: async () => ({ is_staff_or_admin: true, role: 'staff' }) };
  return { ok: true, json: async () => ({}) };
};
const env = (kv) => ({ OVERRIDES: kv, OTRA_API_URL: 'https://og.test/api' });
const DRAFT = 'draft-1792794530651-test';
const text = (value) => ({ type: 'text', value });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function load(kv, id = DRAFT) {
  const response = await adminGet({
    request: new Request(`https://otratickets.com/admin/api/overrides?id=${id}`, { headers: { authorization: 'Bearer t' } }),
    env: env(kv),
  });
  return (await response.json()).override;
}

async function save(kv, body, id = DRAFT) {
  await tick(); // every save gets a new updatedAt
  const response = await adminPut({
    request: new Request(`https://otratickets.com/admin/api/overrides?id=${id}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env: env(kv),
  });
  return { status: response.status, body: await response.json() };
}

function seed() {
  return makeKv({
    [`site-event:${DRAFT}`]: { id: DRAFT, status: 'draft', adminOnly: true, title: 'Strange Bird Flight 2' },
    [`event:${DRAFT}`]: {
      id: DRAFT, description: '', image: '', checkoutEventId: '', accentColor: '#1c9ebd',
      fields: {
        'text:#evTitle': text('Strange Bird Flight 2'),
        'text:#evBandTitle': text('Event Details'),
        'text:#evBandText': text('Doors at 7pm'),
      },
      updatedAt: '2026-10-25T12:00:00.000Z',
    },
  });
}

// ---- 1) server ----
try {
  // Base for a save made from `loaded` that ends at `next`, as the client builds it.
  const ctx = { loadedOverride: null };
  vm.createContext(ctx);
  vm.runInContext(`${(html.match(/const OVERRIDE_TOP_LEVEL_KEYS = \[[^\]]*\];/) || [''])[0]}\n${extractFunction('overrideSaveBase', html)}`, ctx);
  const withBase = (loaded, next) => {
    ctx.loadedOverride = JSON.parse(JSON.stringify(loaded));
    const body = { description: '', image: '', checkoutEventId: '', accentColor: '', draftEditsFrom: '', ...next, fields: { ...next.fields } };
    return { ...body, base: ctx.overrideSaveBase(body) };
  };
  assert(typeof ctx.overrideSaveBase === 'function', 'admin must define overrideSaveBase');

  // a) Flight 2: tab B loaded before tab A fixed Event Details text; B then edits the title.
  {
    const kv = seed();
    const tabA = await load(kv);
    const tabB = await load(kv);
    const a = await save(kv, withBase(tabA, { ...tabA, fields: { ...tabA.fields, 'text:#evBandText': text('Doors at 8pm, show at 9pm') } }));
    assert(a.status === 200, 'first save goes through, got ' + a.status);
    const b = await save(kv, withBase(tabB, { ...tabB, fields: { ...tabB.fields, 'text:#evTitle': text('Strange Bird: Flight 2') } }));
    assert(b.status === 200, 'a stale save on a different key is merged, got ' + b.status + ' ' + JSON.stringify(b.body));
    const doc = kv.doc(`event:${DRAFT}`);
    assert(doc.fields['text:#evBandText']?.value === 'Doors at 8pm, show at 9pm', 'the stale tab must not revert the other editor\'s Event Details text, got ' + JSON.stringify(doc.fields['text:#evBandText']));
    assert(doc.fields['text:#evTitle']?.value === 'Strange Bird: Flight 2', 'the stale tab\'s own edit is kept');
    assert(doc.fields['text:#evBandTitle']?.value === 'Event Details', 'untouched Event Details heading is kept');
    assert(b.body.override.fields['text:#evBandText']?.value === 'Doors at 8pm, show at 9pm', 'the response gives the stale tab the merged state');
  }

  // b) both editors change the same key: 409, nothing stored, message says reload.
  {
    const kv = seed();
    const tabA = await load(kv);
    const tabB = await load(kv);
    await save(kv, withBase(tabA, { ...tabA, fields: { ...tabA.fields, 'text:#evBandText': text('A wording') } }));
    const before = kv.doc(`event:${DRAFT}`);
    const b = await save(kv, withBase(tabB, { ...tabB, fields: { ...tabB.fields, 'text:#evBandText': text('B wording') } }));
    assert(b.status === 409, 'same key changed by both must be 409, got ' + b.status);
    assert(/reload/i.test(b.body.error || '') && /changed/i.test(b.body.error || ''), 'the 409 must tell the editor the page changed and to reload, got ' + JSON.stringify(b.body.error));
    assert(JSON.stringify(b.body.conflictKeys) === JSON.stringify(['text:#evBandText']), 'the 409 names the conflicting key, got ' + JSON.stringify(b.body.conflictKeys));
    assert(JSON.stringify(kv.doc(`event:${DRAFT}`)) === JSON.stringify(before), 'a refused save stores nothing');
  }

  // c) a stale red X on a section the other editor just edited: 409, not a silent wipe.
  {
    const kv = seed();
    const tabA = await load(kv);
    const tabB = await load(kv);
    await save(kv, withBase(tabA, { ...tabA, fields: { ...tabA.fields, 'text:#evBandText': text('New details') } }));
    const fields = { ...tabB.fields };
    delete fields['text:#evBandText'];
    const b = await save(kv, withBase(tabB, { ...tabB, fields }));
    assert(b.status === 409, 'deleting a key another editor changed must be 409, got ' + b.status);
    assert(kv.doc(`event:${DRAFT}`).fields['text:#evBandText']?.value === 'New details', 'the other editor\'s text survives');
  }

  // d) a stale delete of an untouched key merges; a fresh save is applied as sent.
  {
    const kv = seed();
    const tabA = await load(kv);
    const tabB = await load(kv);
    await save(kv, withBase(tabA, { ...tabA, fields: { ...tabA.fields, 'text:#evTitle': text('Renamed') } }));
    const fields = { ...tabB.fields };
    delete fields['text:#evBandTitle'];
    const b = await save(kv, withBase(tabB, { ...tabB, fields }));
    const doc = kv.doc(`event:${DRAFT}`);
    assert(b.status === 200 && !doc.fields['text:#evBandTitle'] && doc.fields['text:#evTitle']?.value === 'Renamed', 'a stale delete of a key nobody else changed is merged, got ' + JSON.stringify(doc.fields));
    const fresh = await load(kv);
    const c = await save(kv, withBase(fresh, { ...fresh, fields: { 'text:#evTitle': text('Only title') } }));
    assert(c.status === 200 && JSON.stringify(Object.keys(kv.doc(`event:${DRAFT}`).fields)) === JSON.stringify(['text:#evTitle']), 'a save from the current version is applied as sent');
  }

  // e) top-level keys: merged when different, 409 when the same.
  {
    const kv = seed();
    const tabA = await load(kv);
    const tabB = await load(kv);
    await save(kv, withBase(tabA, { ...tabA, description: 'Story from A' }));
    const b = await save(kv, withBase(tabB, { ...tabB, accentColor: '#ff0000' }));
    const doc = kv.doc(`event:${DRAFT}`);
    assert(b.status === 200 && doc.description === 'Story from A' && doc.accentColor === '#ff0000', 'different top-level keys merge, got ' + JSON.stringify({ status: b.status, d: doc.description, c: doc.accentColor }));
    const tabC = await load(kv);
    await save(kv, withBase(tabC, { ...tabC, accentColor: '#00ff00' }));
    const d = await save(kv, withBase(tabB, { ...tabB, accentColor: '#0000ff' }));
    assert(d.status === 409 && kv.doc(`event:${DRAFT}`).accentColor === '#00ff00', 'the same top-level key changed twice is 409');
  }

  // f) first save of a page with no override yet, and a page created under a stale "no override" view.
  {
    const kv = makeKv({ [`site-event:${DRAFT}`]: { id: DRAFT, status: 'draft' } });
    const empty = withBase({}, { fields: { 'text:#evTitle': text('First') } });
    assert(empty.base.updatedAt === null, 'no override yet sends a null version');
    const first = await save(kv, empty);
    assert(first.status === 200, 'first save on a page with no override goes through');
    const again = await save(kv, withBase({}, { fields: { 'text:#evTitle': text('Second tab') } }));
    assert(again.status === 409, 'a tab that loaded before the first save cannot overwrite its key');
  }

  // g) a client with no base (tab opened before this check) is saved as sent.
  {
    const kv = seed();
    const legacy = await save(kv, { fields: { 'text:#evTitle': text('Legacy tab') } });
    assert(legacy.status === 200, 'a save without base keeps the old behaviour');
  }
} finally {
  globalThis.fetch = realFetch;
}

// ---- 2) client: every override save sends the base ----
{
  const puts = html.match(/api\("\/admin\/api\/overrides\?id=[^\n]*\n[^\n]*method: "PUT"/g) || [];
  assert(puts.length === 1, 'exactly one PUT to /admin/api/overrides (putOverride), got ' + puts.length);
  const put = extractFunction('putOverride', html);
  assert(/base: overrideSaveBase\(next\)/.test(put), 'putOverride must send base: overrideSaveBase(next)');
  for (const name of ['persistOverrideFields', 'persistCurrentOverride']) {
    const fn = extractFunction(name, html);
    assert(fn.includes('overrideToSave()') && fn.includes('return putOverride(next);'), `${name} must build from overrideToSave and save through putOverride`);
  }
  const fill = extractFunction('fillForm', html);
  assert(/loadedOverride = override \? JSON\.parse\(JSON\.stringify\(override\)\) : null;/.test(fill), 'fillForm must keep a copy of the loaded override as the save base');

  // Local edits before the save (colour picker) are diffed against the loaded copy.
  const ctx = { loadedOverride: { updatedAt: 'v1', accentColor: '#1c9ebd', description: '', fields: { 'text:#a': text('x'), 'text:#b': text('y') } } };
  vm.createContext(ctx);
  vm.runInContext(`${(html.match(/const OVERRIDE_TOP_LEVEL_KEYS = \[[^\]]*\];/) || [''])[0]}\n${extractFunction('overrideSaveBase', html)}`, ctx);
  const base = ctx.overrideSaveBase({ description: '', image: '', checkoutEventId: '', accentColor: '#ff0000', fields: { 'text:#a': text('x'), 'text:#c': text('z') } });
  assert(JSON.stringify(base) === JSON.stringify({ updatedAt: 'v1', top: { accentColor: '#1c9ebd' }, fields: { 'text:#b': text('y'), 'text:#c': null } }), 'base lists only changed keys with their loaded values, got ' + JSON.stringify(base));
}

// ---- 3) draft content modal clears older pencil edits it would be hidden under ----
{
  const targets = (html.match(/const DRAFT_CONTENT_PENCIL_TARGETS = \{[\s\S]*?\n {2}\};/) || [''])[0];
  assert(targets.includes('"#evBandTitle"') && targets.includes('"#evBandText"'), 'admin must map the modal heading/text to their pencil elements');
  const deleted = [];
  const ctx = {
    currentOverride: { fields: {
      'text:#evBandTitle': text('Old pencil heading'),
      'text:main > #evBandText': text('Old pencil text'),
      'text:#evBandEyebrow': text('Kept label'),
    } },
    persistOverrideFields: async (mutate) => {
      const next = { ...ctx.currentOverride.fields };
      mutate(next);
      deleted.push(...Object.keys(ctx.currentOverride.fields).filter((key) => !(key in next)));
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${targets}\n${extractFunction('pencilTextKeys', html)}\n${extractFunction('clearPencilEditsFor', html)}`, ctx);
  const cleared = await ctx.clearPencilEditsFor(['bandTitle', 'bandText']);
  assert(JSON.stringify(deleted.sort()) === JSON.stringify(['text:#evBandTitle', 'text:main > #evBandText']), 'changed heading/text clear their pencil edits (also the main > #id form), got ' + JSON.stringify(deleted));
  assert(JSON.stringify([...cleared]) === JSON.stringify(['section heading', 'section text']), 'the labels cleared are returned for the status line, got ' + JSON.stringify(cleared));
  deleted.length = 0;
  const none = await ctx.clearPencilEditsFor([]);
  assert(none.length === 0 && deleted.length === 0, 'nothing changed in the modal clears nothing');

  const submit = html.slice(html.indexOf('$("draftContentForm").addEventListener("submit"'), html.indexOf('$("publishDraftBtn").addEventListener'));
  assert(/patch\[name\] !== opened\[name\]/.test(submit), 'only fields changed in the modal clear their pencil edit');
  assert(submit.indexOf('await loadPages(project.id)') > -1 && submit.indexOf('await loadPages(project.id)') < submit.indexOf('clearPencilEditsFor(changedNames)'), 'pencil edits are cleared after reloading the override (fresh base)');
  assert(/draftContentOpened = draftContentPencilValues\(\);/.test(html), 'the modal remembers the values it opened with');
  assert(/\.\.\.draftContentPencilValues\(\),/.test(submit), 'the modal patch reads the same inputs');
}

if (failures.length) {
  console.error('check-admin-override-conflict FAILED:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('check-admin-override-conflict OK (stale saves merge per key, same-key conflicts 409 with reload, every client save sends its base, modal clears stale pencil edits)');
