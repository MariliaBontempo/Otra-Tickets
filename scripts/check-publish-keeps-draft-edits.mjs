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

// 2. Event documents saved before this change keep rendering exactly as
//    they do today, so shipping the merge changes no live page.
{
  const legacyDoc = {
    id: '7175', description: '', image: '', checkoutEventId: '', accentColor: '',
    fields: { 'text:#evTitle': text('Later title'), 'text:#evSub': text('Later subtitle') },
    updatedAt: '2026-10-12T12:00:00.000Z',
  };
  const kv = makeKv({ [`site-event:${DRAFT}`]: project(), [`event:${DRAFT}`]: draftEdits, 'event:7175': legacyDoc });
  const page = await publicFields(kv, '7175');
  eq(page.fields, legacyDoc.fields, '2: an older live document without a marker is served as is');
  eq(page.description, '', '2: and its top level values too');
  const loaded = await adminLoad(kv, '7175');
  eq(loaded.fields, legacyDoc.fields, '2: the editor opens what the page shows');
  eq(loaded.draftEditsFrom, DRAFT, '2: the editor still learns the bound draft');
  await adminSave(kv, '7175', editorBody(loaded, (next) => { next.fields['text:#evTitle'] = text('Edited again'); }));
  eq(Object.keys((await publicFields(kv, '7175')).fields).sort(), ['text:#evSub', 'text:#evTitle'], '2: saving it changes only the edited key');
  assert(!('draftEditsFrom' in kv.json('event:7175')), '2: an editor save on a page served as is adds no marker');
  eq(kv.json('event:7175').draftEditsHidden, DRAFT, '2: a save on a page served as is names the draft it hides');
  eq(kv.json('event:7175').pageEditsVersion, 2, '2: and writes the format marker');
  await adminSave(kv, '7175', editorBody(await adminLoad(kv, '7175'), (next) => { next.fields['text:#evSub'] = text('Third save'); }));
  eq(Object.keys((await publicFields(kv, '7175')).fields).sort(), ['text:#evSub', 'text:#evTitle'], '2: later saves still keep that draft hidden');
  eq(kv.json('event:7175').draftEditsHidden, DRAFT, '2: and keep naming it');
  // An editor tab opened before the fix sends only what it saw and the
  // page stays the same.
  const stale = makeKv({ [`site-event:${DRAFT}`]: project(), [`event:${DRAFT}`]: draftEdits, 'event:7175': legacyDoc });
  await adminSave(stale, '7175', { fields: { 'text:#evTitle': text('Stale tab title'), 'text:#evSub': text('Later subtitle') } });
  eq(stale.json('event:7175').fields, { 'text:#evTitle': text('Stale tab title'), 'text:#evSub': text('Later subtitle') }, '2: stale tab save on an old page keeps the old page keys');
  assert(!('draftEditsFrom' in stale.json('event:7175')), '2: a page served as is gets no draft marker, so its hidden draft edits stay restorable');
  await adminSave(stale, '7175', { fields: { 'text:#evTitle': text('Stale tab title') } });
  eq(stale.json('event:7175').fields, { 'text:#evTitle': text('Stale tab title') }, '2: a stale tab removal on a page served as is sticks');
  eq(Object.keys((await publicFields(stale, '7175')).fields), ['text:#evTitle'], '2: and the page shows the removal');
  // A stale tab on a freshly published page (no live document yet) keeps
  // the draft edits under its change.
  const fresh = makeKv({ [`site-event:${DRAFT}`]: project(), [`event:${DRAFT}`]: draftEdits });
  await adminSave(fresh, '7175', { fields: { 'text:#evTitle': text('Stale tab title') } });
  const stored = fresh.json('event:7175');
  eq(stored.fields['text:#evMeta'], text('Every Saturday · 90 min'), '2: stale client save keeps the draft hero line');
  eq(stored.fields['text:#evTitle'], text('Stale tab title'), '2: stale client edit wins its key');
  eq(stored.description, 'Draft description', '2: stale client save keeps the description');
  // A draft newer than an old live document (a new draft bound to an event
  // that already had page edits) is merged, its edits winning shared keys.
  const rebound = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`event:${DRAFT}`]: draftEdits,
    'event:7175': { ...legacyDoc, updatedAt: '2026-01-01T00:00:00.000Z' },
  });
  const merged = await publicFields(rebound, '7175');
  eq(merged.fields['text:#evTitle'], text('Water Bikes Curaçao'), '2: the newer draft wins the shared key');
  eq(merged.fields['text:#evSub'], text('Later subtitle'), '2: old live only keys stay');
  eq(merged.fields['text:#evMeta'], text('Every Saturday · 90 min'), '2: newer draft only keys show');
}

// 2b. A live page edit saved after this change, before a draft bound to
//     that event is published, does not hide the draft edits.
{
  const EXISTING = 'draft-1795000000000-dddddddd';
  const kv = makeKv({
    [`site-event:${EXISTING}`]: project({ id: EXISTING, status: 'draft', publishedAt: '', usesExistingOtraGuideEvent: true }),
    [`event:${EXISTING}`]: { fields: { 'text:#evTitle': text('Draft title'), 'text:#evMeta': text('Draft meta') }, updatedAt: '2026-10-05T00:00:00.000Z' },
  });
  await adminSave(kv, '7175', { fields: { 'text:#evTitle': text('Live edit') } });
  const saved = kv.json('event:7175');
  eq(saved.pageEditsVersion, 2, '2b: a live save after this change writes the format marker');
  assert(!('draftEditsFrom' in saved), '2b: no draft marker while the draft is unpublished');
  eq((await publicFields(kv, '7175')).fields, { 'text:#evTitle': text('Live edit') }, '2b: an unpublished draft does not feed the live page');
  // Publish the (older) draft.
  kv.store.set(`site-event:${EXISTING}`, JSON.stringify(project({ id: EXISTING, usesExistingOtraGuideEvent: true })));
  const page = await publicFields(kv, '7175');
  eq(page.fields['text:#evMeta'], text('Draft meta'), '2b: after publish the draft edits show');
  eq(page.fields['text:#evTitle'], text('Live edit'), '2b: the later live edit wins its key');
  const loaded = await adminLoad(kv, '7175');
  eq(loaded.draftEditsFrom, EXISTING, '2b: the editor merges the published draft');
}

// 2c. A legacy live page saved after deploy still merges a different draft
//     published later, even one whose document is older than that save.
{
  const B = 'draft-1796000000000-eeeeeeee';
  const kv = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`event:${DRAFT}`]: draftEdits,
    'event:7175': { fields: { 'text:#evTitle': text('Old live title') }, updatedAt: '2026-10-12T00:00:00.000Z' },
    [`site-event:${B}`]: project({ id: B, status: 'draft', publishedAt: '', createdAt: '2026-09-30T00:00:00.000Z' }),
    [`event:${B}`]: { fields: { 'text:#evMeta': text('B meta') }, updatedAt: '2026-10-01T00:00:00.000Z' },
  });
  const before = await publicFields(kv, '7175');
  eq(before.fields, { 'text:#evTitle': text('Old live title') }, '2c: the legacy page renders as before');
  await adminSave(kv, '7175', editorBody(await adminLoad(kv, '7175'), (next) => { next.fields['text:#evTitle'] = text('Saved after deploy'); }));
  eq(kv.json('event:7175').draftEditsHidden, DRAFT, '2c: the save names the hidden draft');
  // B is published and the old draft archived.
  kv.store.set(`site-event:${DRAFT}`, JSON.stringify(project({ archivedAt: '2026-10-20T00:00:00.000Z' })));
  kv.store.set(`site-event:${B}`, JSON.stringify(project({ id: B, createdAt: '2026-09-30T00:00:00.000Z', publishedAt: '2026-10-20T00:00:00.000Z' })));
  const after = await publicFields(kv, '7175');
  eq(after.fields['text:#evMeta'], text('B meta'), '2c: the newly published draft edits show');
  eq(after.fields['text:#evTitle'], text('Saved after deploy'), '2c: the later live edit wins its key');
  assert(!('text:#evMeta' in before.fields) && !after.fields['text:#evMeta'].value.includes('Every Saturday'), '2c: the hidden old draft stays out');
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
  assert(!('draftEditsFrom' in kv.json('event:6113')), '4: unbound save adds no draft marker');
  eq(kv.json('event:6113').pageEditsVersion, 2, '4: unbound save writes the format marker');
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

// 7. The homepage card reads the same merged view, removals included.
{
  const hero = { type: 'image', value: '/override-images/draft-hero.jpg' };
  const draftDoc = { ...draftEdits, fields: { ...draftEdits.fields, 'image:#evHeroImg': hero } };
  const legacy = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`event:${DRAFT}`]: draftDoc,
    'event:7175': { fields: { 'text:#evSub': text('Older live only') }, updatedAt: '2026-01-01T00:00:00.000Z' },
  });
  let cards = await applyOverrides(await buildPublishedSiteEvents({ OVERRIDES: legacy }), { OVERRIDES: legacy });
  let card = cards.find((item) => String(item.id) === '7175');
  eq(card && card.title, 'Water Bikes Curaçao', '7: card shows the draft title merged over an older live document');
  eq(card && card.img, '/override-images/draft-hero.jpg', '7: card shows the draft hero merged over an older live document');
  // The editor removes the title and hero edits on the live page.
  const kv = makeKv({ [`site-event:${DRAFT}`]: project({ image: '/stock.jpg' }), [`event:${DRAFT}`]: draftDoc });
  const loaded = await adminLoad(kv, '7175');
  await adminSave(kv, '7175', editorBody(loaded, (next) => { delete next.fields['text:#evTitle']; delete next.fields['image:#evHeroImg']; }));
  cards = await applyOverrides(await buildPublishedSiteEvents({ OVERRIDES: kv }), { OVERRIDES: kv });
  card = cards.find((item) => String(item.id) === '7175');
  eq(card && card.title, 'Water Bikes', '7: a title edit removed on the live page leaves the card');
  eq(card && card.img, '/stock.jpg', '7: a hero edit removed on the live page leaves the card');
}

// 7b. A save on the draft id of a published bound draft is refused, so a
//     stale tab cannot change edits merged under the live page.
{
  const kv = makeKv({ [`site-event:${DRAFT}`]: project(), [`event:${DRAFT}`]: draftEdits });
  const loaded = await adminLoad(kv, '7175');
  await adminSave(kv, '7175', editorBody(loaded, (next) => { next.fields['text:#evTitle'] = text('LIVE title'); delete next.fields['text:#evMeta']; }));
  const refused = await adminSave(kv, DRAFT, { fields: { 'text:#evTitle': text('stale draft title'), 'text:#evMeta': text('stale meta') } });
  eq(refused.status, 409, '7b: draft id save on a published bound draft is refused');
  eq(refused.body.liveId, '7175', '7b: the refusal names the live page');
  eq(kv.json(`event:${DRAFT}`), draftEdits, '7b: the draft document is unchanged');
  const page = await publicFields(kv, '7175');
  eq(page.fields['text:#evTitle'], text('LIVE title'), '7b: the live edit stays');
  assert(!('text:#evMeta' in page.fields), '7b: the live removal stays');
  // Unpublished drafts (bound or not) still save on their own id.
  const wip = makeKv({ [`site-event:${DRAFT}`]: project({ status: 'draft', publishedAt: '' }) });
  eq((await adminSave(wip, DRAFT, { fields: { 'text:#evTitle': text('WIP') } })).status, 200, '7b: an unpublished bound draft still saves');
  const archived = makeKv({ [`site-event:${DRAFT}`]: project({ archivedAt: '2026-10-11T00:00:00.000Z' }) });
  eq((await adminSave(archived, DRAFT, { fields: { 'text:#evTitle': text('x') } })).status, 200, '7b: an archived draft id still saves on its own page');
  // If a draft document does change after the stamped save, its edits are
  // merged again by time instead of being silently ignored.
  const doc = kv.json('event:7175');
  kv.store.set(`event:${DRAFT}`, JSON.stringify({ ...draftEdits, fields: { 'text:#evNew': text('newer draft') }, updatedAt: '2099-01-01T00:00:00.000Z' }));
  const { override } = await resolvePageOverride(kv, '7175');
  eq(override.fields['text:#evNew'], text('newer draft'), '7b: a draft document newer than the stamped save is merged');
  eq(override.fields['text:#evTitle'], doc.fields['text:#evTitle'], '7b: keys the newer draft does not set keep the live value');
}

// 7c. Several bound drafts: only the published one feeds the live page.
{
  const WIP = 'draft-1900000000000-cccccccc';
  const kv = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`event:${DRAFT}`]: draftEdits,
    [`site-event:${WIP}`]: project({ id: WIP, status: 'draft', publishedAt: '', createdAt: '2026-10-15T00:00:00.000Z' }),
    [`event:${WIP}`]: { fields: { 'text:#evTitle': text('WIP title') }, updatedAt: '2026-10-16T00:00:00.000Z' },
  });
  const page = await publicFields(kv, '7175');
  eq(page.fields['text:#evTitle'], text('Water Bikes Curaçao'), '7c: an unpublished bound draft does not leak into the live page');
  eq((await adminLoad(kv, '7175')).draftEditsFrom, DRAFT, '7c: the editor merges the published draft');
}

// 7d. Legacy override:<id> keys, missing dates and malformed records.
{
  const kv = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`override:${DRAFT}`]: { fields: { a: text('draft a'), b: text('draft b') } },
    'override:7175': { fields: { b: text('live b') } },
    'site-event:draft-broken': 'not json',
  });
  kv.store.set('site-event:draft-broken', '{oops');
  const page = await publicFields(kv, '7175');
  eq(page.fields, { b: text('live b') }, '7d: a legacy live document without dates is served as is');
  const kv2 = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`override:${DRAFT}`]: { fields: { a: text('draft a'), b: text('draft b') }, updatedAt: '2026-10-09T00:00:00.000Z' },
    'override:7175': { fields: { b: text('live b') } },
  });
  eq((await publicFields(kv2, '7175')).fields, { b: text('draft b'), a: text('draft a') }, '7d: legacy keys merge when the draft is newer');
}

// 7e. /api/event takes description, image and accent from the merged view.
{
  const { onRequestGet: eventGet } = await import('../functions/api/event.js');
  const kv = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`event:${DRAFT}`]: draftEdits,
    'event:7175': { description: '', image: '/override-images/live.jpg', fields: { 'text:#evTitle': text('Older') }, updatedAt: '2026-01-01T00:00:00.000Z' },
  });
  const savedCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  const stubFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/events/details/7175/')) return new Response(JSON.stringify({ id: 7175, title: 'Water Bikes', description: 'Upstream', start_date: '2026-06-01T09:00:00-04:00' }), { headers: { 'content-type': 'application/json' } });
    if (url.includes('/ticket/purchase/tickets/7175/')) return new Response(JSON.stringify({ count: 0, results: [] }), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  };
  try {
    const response = await eventGet({ request: new Request('https://otratickets.com/api/event?id=7175'), env: env(kv), waitUntil() {} });
    const payload = await response.json();
    eq(payload.description, 'Draft description', '7e: /api/event keeps the draft description');
    eq(payload.image, '/override-images/live.jpg', '7e: /api/event keeps the live image the draft does not set');
    eq(payload.accent, '#112233', '7e: /api/event keeps the draft accent');
  } finally {
    globalThis.fetch = stubFetch;
    globalThis.caches = savedCaches;
  }
}

// 7f. The audit entry of the first save after publish lists only real changes.
{
  const kv = makeKv({ [`site-event:${DRAFT}`]: project(), [`event:${DRAFT}`]: draftEdits });
  const loaded = await adminLoad(kv, '7175');
  await adminSave(kv, '7175', editorBody(loaded, (next) => { next.fields['text:#evTitle'] = text('Changed'); }));
  const audit = kv.json('audit:event:7175');
  const entries = Array.isArray(audit) ? audit : (audit && audit.entries) || [];
  const last = entries[entries.length - 1] || entries[0] || {};
  eq(last.changedFields, ['fields.text:#evTitle'], '7f: audit lists only the edited key');
}

// 8. Cloning a live page copies the merged view.
{
  const { onRequestPost } = await import('../functions/admin/api/projects.js');
  const kv = makeKv({
    [`site-event:${DRAFT}`]: project(),
    [`event:${DRAFT}`]: draftEdits,
    'event:7175': { fields: { 'text:#evSub': text('Older sub') }, updatedAt: '2026-01-01T00:00:00.000Z' },
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
  eq(cloneDoc && cloneDoc.fields['text:#evSub'], text('Older sub'), '8: clone keeps the live only key');
  assert(cloneDoc && !('draftEditsFrom' in cloneDoc) && !('pageEditsVersion' in cloneDoc) && !('draftEditsHidden' in cloneDoc), '8: clone document carries no markers');
}

globalThis.fetch = realFetch;

if (failures.length) {
  console.error(`publish keeps draft edits: ${failures.length} of ${checks} checks failed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`publish keeps draft edits: ${checks} checks passed`);
