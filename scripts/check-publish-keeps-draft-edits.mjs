// Oracle: page edits made on a draft survive the first edit saved after the
// draft is published. Before publish the admin edits event:<draftId>; after
// publish it edits event:<otraGuideId>. The public page, the admin editor,
// the homepage card and a clone all read one merged view where later edits
// win per key.
// Run: node scripts/check-publish-keeps-draft-edits.mjs

import { onRequestGet as adminGet, onRequestPut as adminPut } from '../functions/admin/api/overrides.js';
import { onRequestGet as publicGet } from '../functions/api/override.js';
import { applyOverrides, buildPublishedSiteEvents } from '../functions/_lib/homepage-feed.js';
import { mergeOverrideDocs, resolvePageOverride } from '../functions/_lib/page-override.js';

const failures = [];
let checks = 0;
const assert = (condition, message) => {
  checks += 1;
  if (!condition) failures.push(message);
};
const eq = (actual, expected, message) =>
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);

function makeKv(records = {}) {
  const store = new Map(Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      return {
        keys: [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
    json(key) {
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/users/user-role/')) return { ok: true, json: async () => ({ is_staff_or_admin: true, role: 'staff' }) };
  return { ok: true, json: async () => ({}) };
};

const env = (kv) => ({ OVERRIDES: kv, OTRA_API_URL: 'https://og.test/api' });

async function adminLoad(kv, id) {
  const response = await adminGet({
    request: new Request(`https://otratickets.com/admin/api/overrides?id=${id}`, { headers: { authorization: 'Bearer test-token' } }),
    env: env(kv),
  });
  return (await response.json()).override;
}

async function adminSave(kv, id, body) {
  const response = await adminPut({
    request: new Request(`https://otratickets.com/admin/api/overrides?id=${id}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env: env(kv),
  });
  return { status: response.status, body: await response.json() };
}

// What the editor does: start from the loaded override and send it back whole.
function editorBody(loaded, mutate) {
  const next = {
    description: loaded && loaded.description ? loaded.description : '',
    image: loaded && loaded.image ? loaded.image : '',
    checkoutEventId: loaded && loaded.checkoutEventId ? loaded.checkoutEventId : '',
    accentColor: loaded && loaded.accentColor ? loaded.accentColor : '',
    fields: Object.assign({}, loaded && loaded.fields ? loaded.fields : {}),
    draftEditsFrom: loaded && loaded.draftEditsFrom ? loaded.draftEditsFrom : '',
  };
  mutate(next);
  return next;
}

async function publicFields(kv, id) {
  const response = await publicGet({ request: new Request(`https://otratickets.com/api/override?id=${id}`), env: env(kv) });
  const { override } = await response.json();
  return override;
}

const text = (value) => ({ type: 'text', value });
const DRAFT = 'draft-1792027782885-489f9785';
const project = (overrides = {}) => ({
  id: DRAFT,
  title: 'Water Bikes',
  status: 'published',
  publishedAt: '2026-10-10T12:00:00.000Z',
  createdAt: '2026-10-01T12:00:00.000Z',
  adminOnly: false,
  otraGuideId: '7175',
  startDate: '2026-11-01',
  ticketTypeIds: [],
  claudeDesign: { rates: [] },
  ...overrides,
});
const draftEdits = {
  id: DRAFT,
  description: 'Draft description',
  image: '',
  checkoutEventId: '',
  accentColor: '#112233',
  fields: {
    'text:#evMeta': text('Every Saturday · 90 min'),
    'text:#evTitle': text('Water Bikes Curaçao'),
    'text:.info-cell:nth-of-type(2)': text('Departures 9:00 and 14:00'),
  },
  updatedAt: '2026-10-09T12:00:00.000Z',
};

// 1. Edits made before publish survive the first edit made after publish.
{
  const kv = makeKv({ [`site-event:${DRAFT}`]: project(), [`event:${DRAFT}`]: draftEdits });
  const loaded = await adminLoad(kv, '7175');
  eq(Object.keys(loaded.fields).sort(), Object.keys(draftEdits.fields).sort(), '1: the editor opens a published page with its draft edits');
  eq(loaded.draftEditsFrom, DRAFT, '1: the editor learns which draft the view came from');
  const saved = await adminSave(kv, '7175', editorBody(loaded, (next) => { next.fields['text:#evTitle'] = text('Water Bikes Willemstad'); }));
  eq(saved.status, 200, '1: save succeeds');
  const page = await publicFields(kv, '7175');
  eq(page.fields['text:#evMeta'], text('Every Saturday · 90 min'), '1: hero line edited on the draft survives');
  eq(page.fields['text:.info-cell:nth-of-type(2)'], text('Departures 9:00 and 14:00'), '1: departures cell edited on the draft survives');
  eq(page.fields['text:#evTitle'], text('Water Bikes Willemstad'), '1: the new edit is on the page');
  eq(page.description, 'Draft description', '1: draft description survives');
  eq(page.accentColor, '#112233', '1: draft accent survives');
  eq(kv.json('event:7175').draftEditsFrom, DRAFT, '1: the saved document records the draft it covers');
  eq(kv.json(`event:${DRAFT}`), draftEdits, '1: the draft document itself is untouched');
}

// 2. A page already broken by the bug (event doc holding only the later
//    edit) shows the draft edits again, later edits winning per key.
{
  const kv = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`event:${DRAFT}`]: draftEdits,
    'event:7175': {
      id: '7175', description: '', image: '', checkoutEventId: '', accentColor: '',
      fields: { 'text:#evTitle': text('Later title'), 'text:#evSub': text('Later subtitle') },
      updatedAt: '2026-10-12T12:00:00.000Z',
    },
  });
  const page = await publicFields(kv, '7175');
  eq(page.fields['text:#evMeta'], text('Every Saturday · 90 min'), '2: hidden draft hero line is back');
  eq(page.fields['text:#evTitle'], text('Later title'), '2: later edit wins the shared key');
  eq(page.fields['text:#evSub'], text('Later subtitle'), '2: later only key kept');
  eq(page.description, 'Draft description', '2: empty later description does not erase the draft one');
  // An editor tab opened before the fix sends only what it saw; the server
  // keeps the draft edits under it.
  await adminSave(kv, '7175', { fields: { 'text:#evTitle': text('Stale tab title') } });
  const stored = kv.json('event:7175');
  eq(stored.fields['text:#evMeta'], text('Every Saturday · 90 min'), '2: stale client save keeps the draft hero line');
  eq(stored.fields['text:#evSub'], text('Later subtitle'), '2: stale client save keeps earlier later edits');
  eq(stored.fields['text:#evTitle'], text('Stale tab title'), '2: stale client edit wins its key');
  eq(stored.description, 'Draft description', '2: stale client save keeps the description');
}

// 3. Later edits win per key, in both directions, by document time.
{
  const older = { fields: { a: text('old a'), b: text('old b') }, description: 'old', updatedAt: '2026-10-01T00:00:00.000Z' };
  const newer = { fields: { b: text('new b'), c: text('new c') }, description: '', updatedAt: '2026-10-02T00:00:00.000Z' };
  const merged = mergeOverrideDocs(older, newer);
  eq(merged.fields, { a: text('old a'), b: text('new b'), c: text('new c') }, '3: event doc newer wins shared key');
  eq(merged.description, 'old', '3: empty newer top level value falls back');
  const flipped = mergeOverrideDocs({ ...newer, updatedAt: '2026-10-03T00:00:00.000Z' }, { ...older, updatedAt: '2026-10-02T00:00:00.000Z' });
  eq(flipped.fields.b, text('new b'), '3: a draft document edited later wins its keys');
  // Several saves after publish: each later save wins over the previous one.
  const kv = makeKv({ [`site-event:${DRAFT}`]: project(), [`event:${DRAFT}`]: draftEdits });
  let loaded = await adminLoad(kv, '7175');
  await adminSave(kv, '7175', editorBody(loaded, (next) => { next.fields['text:#evMeta'] = text('Daily · 90 min'); }));
  loaded = await adminLoad(kv, '7175');
  await adminSave(kv, '7175', editorBody(loaded, (next) => { next.fields['text:#evMeta'] = text('Daily · 2 hours'); }));
  const page = await publicFields(kv, '7175');
  eq(page.fields['text:#evMeta'], text('Daily · 2 hours'), '3: the latest save wins the key');
  eq(page.fields['text:#evTitle'], text('Water Bikes Curaçao'), '3: untouched draft keys stay');
  // A deliberate removal after publish sticks (the merged doc is final).
  loaded = await adminLoad(kv, '7175');
  await adminSave(kv, '7175', editorBody(loaded, (next) => { delete next.fields['text:.info-cell:nth-of-type(2)']; }));
  const afterDelete = await publicFields(kv, '7175');
  assert(!('text:.info-cell:nth-of-type(2)' in afterDelete.fields), '3: a key removed after publish stays removed');
  eq(afterDelete.fields['text:#evTitle'], text('Water Bikes Curaçao'), '3: other draft keys stay after a removal');
}

// 4. No draft edits: pages without a draft document behave exactly as before.
{
  const eventOnly = { id: '6113', description: 'Clearboat', image: '', checkoutEventId: '', accentColor: '', fields: { 'text:#evTitle': text('Clearboat') }, updatedAt: '2026-01-01T00:00:00.000Z' };
  const kv = makeKv({ 'event:6113': eventOnly });
  eq(await publicFields(kv, '6113'), { description: 'Clearboat', image: '', checkoutEventId: '', accentColor: '', fields: eventOnly.fields, updatedAt: eventOnly.updatedAt }, '4: unbound page serves its own document');
  const loaded = await adminLoad(kv, '6113');
  assert(!loaded.draftEditsFrom, '4: no draft marker for an unbound page');
  await adminSave(kv, '6113', editorBody(loaded, (next) => { delete next.fields['text:#evTitle']; }));
  eq(kv.json('event:6113').fields, {}, '4: removal on an unbound page sticks');
  assert(!('draftEditsFrom' in kv.json('event:6113')), '4: unbound save adds no marker');
  // Bound but the draft had no edits.
  const kv2 = makeKv({ [`site-event:${DRAFT}`]: project() });
  const loaded2 = await adminLoad(kv2, '7175');
  eq(loaded2, null, '4: bound draft without edits opens empty');
  await adminSave(kv2, '7175', { fields: { 'text:#evTitle': text('Only edit') } });
  eq((await publicFields(kv2, '7175')).fields, { 'text:#evTitle': text('Only edit') }, '4: bound draft without edits keeps the new edit only');
  // Nothing at all.
  eq(await publicFields(makeKv(), '7175'), null, '4: no documents still answers null');
  // The draft id page itself still edits only the draft document.
  const kv3 = makeKv({ [`site-event:${DRAFT}`]: project({ status: 'draft', publishedAt: '' }), [`event:${DRAFT}`]: draftEdits, 'event:7175': { fields: { x: text('x') } } });
  const draftView = await adminLoad(kv3, DRAFT);
  eq(draftView.fields, draftEdits.fields, '4: the draft page opens its own document');
  assert(!draftView.draftEditsFrom, '4: the draft page carries no marker');
}

// 5. Archived drafts never leak their edits into the live page.
{
  const kv = makeKv({
    [`site-event:${DRAFT}`]: project({ archivedAt: '2026-10-11T00:00:00.000Z' }),
    [`event:${DRAFT}`]: draftEdits,
    'event:7175': { fields: { 'text:#evTitle': text('Live title') }, updatedAt: '2026-10-12T00:00:00.000Z' },
  });
  eq((await publicFields(kv, '7175')).fields, { 'text:#evTitle': text('Live title') }, '5: archived draft edits stay off the page');
  const loaded = await adminLoad(kv, '7175');
  assert(!loaded.draftEditsFrom, '5: archived draft is not merged in the editor');
  const onlyArchived = makeKv({ [`site-event:${DRAFT}`]: project({ archivedAt: '2026-10-11T00:00:00.000Z' }), [`event:${DRAFT}`]: draftEdits });
  eq(await publicFields(onlyArchived, '7175'), null, '5: an archived draft alone gives the page no edits');
}

// 6. Republished: a newer draft bound to the same Otra Guide event.
{
  const OLD = 'draft-1700000000000-aaaaaaaa';
  const NEW = 'draft-1800000000000-bbbbbbbb';
  const base = {
    [`site-event:${OLD}`]: project({ id: OLD, archivedAt: '2026-10-11T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' }),
    [`event:${OLD}`]: { fields: { 'text:#evMeta': text('Old hero line') }, updatedAt: '2026-09-02T00:00:00.000Z' },
    [`site-event:${NEW}`]: project({ id: NEW, createdAt: '2026-10-12T00:00:00.000Z', publishedAt: '2026-10-14T00:00:00.000Z' }),
    [`event:${NEW}`]: { fields: { 'text:#evMeta': text('New hero line'), 'text:#evSub': text('New sub') }, updatedAt: '2026-10-13T00:00:00.000Z' },
    'event:7175': { fields: { 'text:#evMeta': text('Old hero line'), 'text:#evTitle': text('Kept title') }, draftEditsFrom: OLD, updatedAt: '2026-10-05T00:00:00.000Z' },
  };
  const kv = makeKv(base);
  const page = await publicFields(kv, '7175');
  eq(page.fields['text:#evMeta'], text('New hero line'), '6: the republished draft edits win over the older live document');
  eq(page.fields['text:#evSub'], text('New sub'), '6: new draft only key shows');
  eq(page.fields['text:#evTitle'], text('Kept title'), '6: live only key stays');
  const loaded = await adminLoad(kv, '7175');
  eq(loaded.draftEditsFrom, NEW, '6: the editor merges the current draft, not the archived one');
  await adminSave(kv, '7175', editorBody(loaded, (next) => { next.fields['text:#evMeta'] = text('After republish'); }));
  const after = await publicFields(kv, '7175');
  eq(after.fields['text:#evMeta'], text('After republish'), '6: the first edit after republish wins');
  eq(after.fields['text:#evSub'], text('New sub'), '6: and keeps the republished draft edits');
  // The same draft republished: the covering doc is used as is.
  const same = makeKv({ [`site-event:${DRAFT}`]: project(), [`event:${DRAFT}`]: draftEdits });
  let view = await adminLoad(same, '7175');
  await adminSave(same, '7175', editorBody(view, (next) => { delete next.fields['text:#evMeta']; }));
  const doc = same.json('event:7175');
  const { override } = await resolvePageOverride(same, '7175');
  eq(override, doc, '6: a covering document is served exactly as saved');
  assert(!('text:#evMeta' in override.fields), '6: removal survives a republish of the same draft');
}

// 7. The homepage card reads the same merged view.
{
  const kv = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`event:${DRAFT}`]: { ...draftEdits, fields: { ...draftEdits.fields, 'image:#evHeroImg': { type: 'image', value: '/override-images/draft-hero.jpg' } } },
    'event:7175': { fields: { 'text:#evSub': text('Later only') }, updatedAt: '2026-10-12T00:00:00.000Z' },
  });
  const cards = await applyOverrides(await buildPublishedSiteEvents({ OVERRIDES: kv }), { OVERRIDES: kv });
  const card = cards.find((item) => String(item.id) === '7175');
  eq(card && card.title, 'Water Bikes Curaçao', '7: card keeps the draft title after a later edit');
  eq(card && card.img, '/override-images/draft-hero.jpg', '7: card keeps the draft hero after a later edit');
}

// 8. Cloning a live page copies the merged view.
{
  const { onRequestPost } = await import('../functions/admin/api/projects.js');
  const kv = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`event:${DRAFT}`]: draftEdits,
    'event:7175': { fields: { 'text:#evTitle': text('Later title') }, updatedAt: '2026-10-12T00:00:00.000Z' },
  });
  const response = await onRequestPost({
    request: new Request('https://otratickets.com/admin/api/projects?action=clone&id=7175', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ticketSaleWindows: [] }),
    }),
    env: env(kv),
  });
  const body = await response.json();
  assert(response.status === 201 || response.status === 202, `8: clone succeeds (got ${response.status} ${JSON.stringify(body)})`);
  const cloneDoc = body.project ? kv.json(`event:${body.project.id}`) : null;
  eq(cloneDoc && cloneDoc.fields['text:#evMeta'], text('Every Saturday · 90 min'), '8: clone keeps the draft hero line');
  eq(cloneDoc && cloneDoc.fields['text:#evTitle'], text('Later title'), '8: clone keeps the later title');
  assert(cloneDoc && !('draftEditsFrom' in cloneDoc), '8: clone document carries no marker');
}

globalThis.fetch = realFetch;

if (failures.length) {
  console.error(`publish keeps draft edits: ${failures.length} of ${checks} checks failed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`publish keeps draft edits: ${checks} checks passed`);
