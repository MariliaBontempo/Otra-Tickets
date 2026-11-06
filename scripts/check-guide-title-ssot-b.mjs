// All network calls are mocked. No real Guide/Calendar mutations.
import assert from 'node:assert/strict';
import { normalizeGuideTitle, guideTitleTarget, putTitleSafeProject, readGuideTitle, projectForStorage, discardLinkedTitleCopies } from '../functions/admin/api/_event-title.js';
import { onRequestPut, onRequestGet } from '../functions/admin/api/overrides.js';
import { onRequestPost, onRequestGet as projectsGet } from '../functions/admin/api/projects.js';
import { onRequestGet as pagesGet } from '../functions/admin/api/pages.js';
import { onRequestGet as eventGet } from '../functions/api/event.js';
import { onRequestGet as publicOverrideGet } from '../functions/api/override.js';
import { forgetGuideStatuses } from '../functions/_lib/guide-event-hidden.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { guideTitleSsotId, ownedGuideTitleId, withoutLocalProjectTitle, TITLE_FIELD, styleOnlyTitleField } from '../functions/_lib/title-ownership.js';
import { guideTitleIdForPage } from '../functions/_lib/page-override.js';

function fixture(records = {}, options = {}) {
  const log = [];
  let currentTitle = options.guideTitle || "Current Guide title";
  const store = new Map(Object.entries(records).map(([k, v]) => [k, JSON.stringify(v)]));
  const kv = {
    async get(k, type) { const v = store.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { log.push({ write: k, value: JSON.parse(v) }); if (options.failKV && k.startsWith('event:')) throw new Error('KV unavailable'); store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix }) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  };
  const fetch = async (input, init = {}) => {
    const url = String(input); log.push({ url, init });
    assert.ok(url.startsWith('https://guide.test/api/'), 'custom Calendar API base must be used');
    if (url.endsWith('/users/user-role/')) return Response.json({ is_staff_or_admin: !options.nonstaff, username: 'test-staff' });
    if (url.endsWith('/users/profile/')) return Response.json({ username: 'test-staff' });
    if (/\/event-slug\/\d+\/$/.test(url)) {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-test-jwt');
      assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store');
      if (options.readTimeout) throw Object.assign(new Error('timeout'), { name:'TimeoutError' });
      if (options.readStatus) return Response.json({ error:'Read failed' }, { status:options.readStatus });
      return Response.json(options.readMalformed || { id:Number(url.match(/event-slug\/(\d+)\//)[1]), title:currentTitle, slug:'stable-link' });
    }
    if (/\/event-title\/\d+\/$/.test(url)) {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-test-jwt');
      assert.equal(init.method, 'POST');
      assert.ok(init.signal, 'bounded media timeout');
      if (options.timeout) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      if (options.status) return Response.json({ error: 'Calendar refused rename' }, { status: options.status });
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body), ['title'], 'only title is written');
      const id = url.match(/event-title\/(\d+)\//)[1];
      currentTitle = body.title;
      return Response.json(options.malformed || { eventId: Number(id), title: body.title, changed: options.unchanged ? false : true });
    }
    if (/\/events\/details\/\d+\/$/.test(url)) return Response.json({id:Number(url.match(/details\/(\d+)/)[1]),title:'Old public cached title'});
    if (url.includes('/events/') || url.includes('/ticket/purchase/')) return Response.json({results:[],events:[],count:0,next:null});
    if (url.includes('/ticketing/')) return new Response('');
    throw new Error(`Unexpected network call: ${url}`);
  };
  const env = { OVERRIDES: kv, OTRA_API_URL: 'https://guide.test/api' };
  async function run(fn, path, body, auth = true) {
    const real = globalThis.fetch; globalThis.fetch = fetch;
    const oldCaches = globalThis.caches;
    globalThis.caches = { default: { async match() { return null; }, async put() {} } };
    forgetGuideStatuses();
    try {
      const request = new Request(`https://ot.test${path}`, {
        method: body === undefined ? 'GET' : path.includes('projects?') ? 'POST' : 'PUT',
        headers: { ...(auth ? { authorization: 'Bearer synthetic-test-jwt' } : {}), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const resp = await fn({ request, env, waitUntil() {} });
      return { status: resp.status, data: await resp.json() };
    } finally { globalThis.fetch = real; globalThis.caches = oldCaches; }
  }
  return { kv, log, env, fetch, run, posts: () => log.filter(c => c.url?.includes('/event-title/')), writes: () => log.filter(c => c.write) };
}
const project = (more = {}) => ({ id: 'draft-test', title: 'Old local', status: 'draft', adminOnly: true, otraGuideId: '8270', usesExistingOtraGuideEvent: false,
  claudeDesign: { title: 'Old title', displayTitle: 'Old hero', description: 'keep me', rates: [] }, frozenSlug: 'stable-link', ...more });
const override = { fields: { [TITLE_FIELD]: { type: 'text', value: 'Old title' }, 'text:#evTag': { type: 'text', value: 'Keep tag' } }, updatedAt: '2026-11-01T12:00:00Z' };
const titleBody = (value = '  Francis Sling Book Launch  ') => ({ fields: { [TITLE_FIELD]: { type: 'text', value } }, base: { fields: { [TITLE_FIELD]: null }, top: {}, updatedAt: null } });

assert.equal(normalizeGuideTitle('  New  '), 'New');
assert.equal(normalizeGuideTitle('😀'.repeat(100)), '😀'.repeat(100));
for (const value of [undefined, null, 123, {}, '', '   ', 'a'.repeat(101), '<b>Title</b>', 'a\u0000b']) assert.throws(() => normalizeGuideTitle(value));
assert.equal(guideTitleSsotId(project()), '8270');
assert.equal(ownedGuideTitleId(project()), '8270', 'alias matches guideTitleSsotId');
assert.equal(guideTitleSsotId(project({ usesExistingOtraGuideEvent: true })), '8270', 'borrowed pages are Guide SSOT');
assert.equal(guideTitleSsotId(project({ usesExistingOtraGuideEvent: 'true' })), '8270', 'truthy borrowed flag is still SSOT');
assert.equal(guideTitleSsotId(project({ otraGuideId: '', checkoutEventId: '9999' })), '9999', 'checkoutEventId binds title when otraGuideId is empty');
assert.equal(guideTitleSsotId(project({ otraGuideId: '8270', checkoutEventId: '9999' })), '8270', 'otraGuideId wins over checkoutEventId');
assert.equal(guideTitleSsotId(project({ keepSellingWhileGuidePrivate: true })), '', 'keep-selling switch stays local');
assert.equal(guideTitleSsotId(project({ id: 'draft-1792794458964-79d36de9', otraGuideId: '8266', usesExistingOtraGuideEvent: true })), '', 'legacy 8266 keep-selling stays local even if borrowed');
assert.equal(guideTitleSsotId(project({ otraGuideId: '', checkoutEventId: '9999', keepSellingWhileGuidePrivate: true })), '');
assert.equal(guideTitleSsotId(project({ otraGuideId: '' })), '');
const sanitized = withoutLocalProjectTitle(project());
assert.equal('title' in sanitized, false); assert.equal('displayTitle' in sanitized.claudeDesign, false); assert.equal('title' in sanitized.claudeDesign, false);
assert.equal(sanitized.claudeDesign.description, 'keep me');

// Plain numeric Guide page with no owned OT project keeps local curated titles (never POST).
let f = fixture({ 'event:8270': { ...override, checkoutEventId: '9999' } });
let r = await f.run(onRequestPut, '/admin/api/overrides?id=8270', {
  fields: { [TITLE_FIELD]: { type: 'text', value: '  Francis Sling Book Launch  ' } },
  base: { fields: { [TITLE_FIELD]: { type: 'text', value: 'Old title' } }, top: {}, updatedAt: '2026-11-01T12:00:00Z' },
});
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(f.posts().length, 0, 'unowned numeric page must not POST Guide title');
assert.equal((await f.kv.get('event:8270', 'json')).fields[TITLE_FIELD].value, 'Francis Sling Book Launch');

// Owned numeric page (bound OT project): Guide-first, no durable local H1 copy.
f = fixture({
  'site-event:draft-bound': project({ id:'draft-bound', status:'published', publishedAt:'2026-11-01T00:00:00Z', otraGuideId:'8270' }),
  'event:8270': { ...override, checkoutEventId: '9999' },
});
r = await f.run(onRequestPut, '/admin/api/overrides?id=8270', titleBody());
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(f.posts().length, 1);
assert.ok(f.posts()[0].url.endsWith('/event-title/8270/')); assert.equal(r.data.guideTitle.title, 'Francis Sling Book Launch');
assert.equal(r.data.guideTitleReadPending, undefined);
assert.ok(f.log.indexOf(f.posts()[0]) < f.log.findIndex(c => c.url?.includes('/event-slug/')), 'GET follows POST');
assert.ok(f.log.indexOf(f.posts()[0]) < f.log.findIndex(c => c.write === 'event:8270' || c.write?.startsWith('event:')), 'Guide POST precedes local page write');
assert.equal((await f.kv.get('event:8270', 'json')).fields[TITLE_FIELD], undefined);
assert.equal(r.data.override.fields['text:#evTag'].value, 'Keep tag', 'concurrent merge preserves unrelated text');
const audit = await f.kv.get('audit:event:8270', 'json');
assert.ok(JSON.stringify(audit).includes('guide:title'), 'audit records Guide rename without persisting title value');

// Owned draft, including old/archived copies, cannot keep durable title mirrors.
f = fixture({ 'site-event:draft-test': project(), 'site-event:draft-older': project({ id: 'draft-older', archivedAt: 'yes' }),
  'event:draft-test': override, 'override:draft-test': override, 'event:draft-older': override });
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', titleBody('Draft rename'));
assert.equal(r.status, 200); assert.equal(f.posts().length, 1);
for (const id of ['draft-test', 'draft-older']) {
  const stored = await f.kv.get(`site-event:${id}`, 'json');
  assert.equal('title' in stored, false); assert.equal('displayTitle' in stored.claudeDesign, false);
  // Drafts must not keep a creation-time frozenSlug; URL can still change pre-publish.
  assert.equal('frozenSlug' in stored, false);
  assert.equal((await f.kv.get(`event:${id}`, 'json')).fields[TITLE_FIELD], undefined);
}
assert.equal((await f.kv.get('override:draft-test', 'json')).fields[TITLE_FIELD], undefined);

// Calendar refusal, timeout or malformed success never creates local fallback.
for (const options of [{ status: 400 }, { status: 401 }, { status: 403 }, { status: 404 }, { status: 500 }, { timeout: true }, { malformed: {} }, { malformed: { eventId: 9999, title: 'New', changed: true } }]) {
  f = fixture({ 'site-event:draft-test': project(), 'event:draft-test': override }, options);
  r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', titleBody('New'));
  assert.equal(r.status, 502); assert.equal(r.data.retryable, true); assert.equal(f.writes().length, 0);
  assert.equal((await f.kv.get('event:draft-test', 'json')).fields[TITLE_FIELD].value, 'Old title');
}
// Guide accepted / local cleanup failed is explicitly retryable, not false success.
f = fixture({ 'site-event:draft-bound': project({ id:'draft-bound', status:'published', publishedAt:'2026-11-01T00:00:00Z', otraGuideId:'8270' }), 'event:8270': override }, { failKV: true });
r = await f.run(onRequestPut, '/admin/api/overrides?id=8270', titleBody('New'));
assert.equal(r.status, 503); assert.match(r.data.error, /Guide title saved/); assert.equal(r.data.retryable, true);

// Input validation and staff gating happen before ANY Guide title mutation (owned page).
const ownedRecords = { 'site-event:draft-bound': project({ id:'draft-bound', status:'published', publishedAt:'2026-11-01T00:00:00Z', otraGuideId:'8270' }), };
for (const value of ['', 'x'.repeat(101), 42, '<span>HTML</span>']) {
  f = fixture(ownedRecords); r = await f.run(onRequestPut, '/admin/api/overrides?id=8270', titleBody(value));
  assert.equal(r.status, 400, String(value)); assert.equal(f.posts().length, 0); assert.equal(f.writes().length, 0);
}
for (const [opts, auth] of [[{}, false], [{ nonstaff: true }, true]]) {
  f = fixture(ownedRecords, opts); r = await f.run(onRequestPut, '/admin/api/overrides?id=8270', titleBody(), auth);
  assert.equal(r.status, 401); assert.equal(f.posts().length, 0); assert.equal(f.writes().length, 0);
}
f = fixture(ownedRecords, { unchanged: true });
r = await f.run(onRequestPut, '/admin/api/overrides?id=8270', titleBody('Same title'));
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.guideTitle.changed, false);

// Unlinked drafts (no Guide id and no checkout id) retain local editing.
f = fixture({ 'site-event:draft-test': project({ otraGuideId: '' }) });
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', titleBody('Local only'));
assert.equal(r.status, 200); assert.equal(f.posts().length, 0);
assert.equal((await f.kv.get('event:draft-test', 'json')).fields[TITLE_FIELD].value, 'Local only');

// Borrowed pages POST Guide title first and keep a local mirror of the
// confirmed title (used only when Guide is private or unreachable).
f = fixture({ 'site-event:draft-test': project({ usesExistingOtraGuideEvent: true }), 'event:draft-test': override });
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', titleBody('Borrowed rename'));
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(f.posts().length, 1);
assert.ok(f.posts()[0].url.endsWith('/event-title/8270/'));
assert.equal((await f.kv.get('event:draft-test', 'json')).fields[TITLE_FIELD].value, 'Borrowed rename');
// A later save without a rename keeps the mirror and never POSTs.
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', { fields: { 'text:#evTag': { type: 'text', value: 'tag' } }, base: { fields: { 'text:#evTag': null } } });
assert.equal(f.posts().length, 1, 'no extra Guide POST');
assert.equal((await f.kv.get('event:draft-test', 'json')).fields[TITLE_FIELD]?.value, 'Borrowed rename', 'mirror kept');

// Checkout-bound draft (empty otraGuideId, numeric checkoutEventId) POSTs that Guide id.
f = fixture({ 'site-event:draft-test': project({ otraGuideId: '', checkoutEventId: '8333' }), 'event:draft-test': override });
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', titleBody('Checkout rename'));
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(f.posts().length, 1);
assert.ok(f.posts()[0].url.endsWith('/event-title/8333/'));
assert.equal((await f.kv.get('event:draft-test', 'json')).fields[TITLE_FIELD].value, 'Checkout rename', 'checkout page keeps a mirror');

// Checkout id may live only on the override document (Daniel draft).
f = fixture({
  'site-event:draft-test': project({ otraGuideId: '', checkoutEventId: undefined, usesExistingOtraGuideEvent: true }),
  'event:draft-test': { ...override, checkoutEventId: '8333' },
});
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', titleBody('Daniel checkout'));
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(f.posts().length, 1);
assert.ok(f.posts()[0].url.endsWith('/event-title/8333/'));

// An unlinked page that only sells another event's tickets must not rename that Guide event.
f = fixture({
  'site-event:draft-test': project({ otraGuideId: '', checkoutEventId: undefined }),
  'event:draft-test': { checkoutEventId: '8333' },
});
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', titleBody('Ticket alias only'));
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(f.posts().length, 0);
assert.equal((await f.kv.get('event:draft-test', 'json')).fields[TITLE_FIELD].value, 'Ticket alias only');

// Keep-selling never POSTs Guide, even with a borrowed flag.
f = fixture({ 'site-event:draft-test': project({ keepSellingWhileGuidePrivate: true }) });
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', titleBody('Keep selling local'));
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(f.posts().length, 0);
assert.equal((await f.kv.get('event:draft-test', 'json')).fields[TITLE_FIELD].value, 'Keep selling local');
f = fixture({
  'site-event:draft-1792794458964-79d36de9': project({ id: 'draft-1792794458964-79d36de9', otraGuideId: '8266', usesExistingOtraGuideEvent: true }),
});
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-1792794458964-79d36de9', titleBody('Legacy keep selling'));
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(f.posts().length, 0);
assert.equal((await f.kv.get('event:draft-1792794458964-79d36de9', 'json')).fields[TITLE_FIELD].value, 'Legacy keep selling');

f = fixture({ 'site-event:draft-test': project({ status: 'published', usesExistingOtraGuideEvent: true }) });
assert.equal(await guideTitleTarget(f.kv, '8270'), '8270', 'numeric page bound to borrowed project writes Guide');


// Mixed binding: owned draft and borrowed published page share one Guide title.
f = fixture({ 'site-event:draft-test': project(),
 'site-event:draft-borrowed': project({ id:'draft-borrowed', status:'published', usesExistingOtraGuideEvent:true }),
 'event:8270': override, 'event:draft-test':override });
r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', titleBody('Owned rename'));
assert.equal(r.status,200); assert.equal(f.posts().length,1);
// The canonical page belongs to the borrowed published project: it keeps its
// local H1 and title as the fallback for a private/unreachable Guide.
assert.equal((await f.kv.get('event:8270','json')).fields[TITLE_FIELD].value,'Old title');
assert.equal((await f.kv.get('event:draft-test','json')).fields[TITLE_FIELD],undefined);
assert.equal('title' in (await f.kv.get('site-event:draft-borrowed','json')), true);

// Non-title/stale full-form edits on an owned page never replay the title, but clean stale copies.
f = fixture({ 'site-event:draft-bound': project({ id:'draft-bound', status:'published', publishedAt:'2026-11-01T00:00:00Z', otraGuideId:'8270' }), 'event:8270': override });
r = await f.run(onRequestPut, '/admin/api/overrides?id=8270', { fields: override.fields, base: { fields: {}, top: {} } });
assert.equal(r.status, 200); assert.equal(f.posts().length, 0); assert.equal(r.data.override.fields[TITLE_FIELD], undefined);

// Legacy clients without base carrying the old H1 do not replay stale titles on owned pages.
f = fixture({ 'site-event:draft-bound': project({ id:'draft-bound', status:'published', publishedAt:'2026-11-01T00:00:00Z', otraGuideId:'8270' }), 'event:8270': override });
r = await f.run(onRequestPut, '/admin/api/overrides?id=8270', { fields: override.fields, description: 'Other edit' });
assert.equal(r.status, 200); assert.equal(f.posts().length, 0); assert.equal(r.data.override.fields[TITLE_FIELD], undefined);
// A title + other-field conflict does not mutate Guide before the 409.
f = fixture({ 'site-event:draft-bound': project({ id:'draft-bound', status:'published', publishedAt:'2026-11-01T00:00:00Z', otraGuideId:'8270' }), 'event:8270': { fields: { 'text:#evTag': {type:'text', value:'Latest tag'} }, updatedAt:'2026-11-05T12:00:00Z' } });
r = await f.run(onRequestPut, '/admin/api/overrides?id=8270', {
 fields: { [TITLE_FIELD]: { type:'text', value:'New name' }, 'text:#evTag': {type:'text',value:'My tag'} },
 base: { updatedAt:'2026-11-01T12:00:00Z', top:{}, fields:{ [TITLE_FIELD]:null, 'text:#evTag':{type:'text',value:'Original tag'} } }
});
assert.equal(r.status,409);assert.equal(f.posts().length,0);assert.equal(f.writes().length,0);

// Staff GET projection omits legacy H1 for owned pages; unowned numeric keeps local curated title.
f = fixture({ 'site-event:draft-test': project(), 'event:draft-test': override, 'site-event:draft-bound': project({ id:'draft-bound', status:'published', publishedAt:'2026-11-01T00:00:00Z', otraGuideId:'8270' }), 'event:8270': override });
r = await f.run(onRequestGet, '/admin/api/overrides?id=draft-test');
assert.equal(r.status, 200); assert.equal(r.data.override.fields[TITLE_FIELD], undefined);
assert.equal(r.data.guideTitle.title, 'Current Guide title', 'editor reload reads Guide, not legacy local title');
r = await f.run(onRequestGet, '/admin/api/overrides?id=8270');
assert.equal(r.status, 200); assert.equal(r.data.override.fields[TITLE_FIELD], undefined);
assert.equal(r.data.guideTitle.title, 'Current Guide title');

// Project rename path uses the same upstream-first helper and no durable copy.
f = fixture({ 'site-event:draft-test': project(), 'event:draft-test': override });
r = await f.run(onRequestPost, '/admin/api/projects?action=rename&id=draft-test', { name: 'Project rename' });
assert.equal(r.status, 200); assert.equal(f.posts().length, 1); assert.equal(r.data.guideTitle.title, 'Project rename');
assert.equal('title' in (await f.kv.get('site-event:draft-test', 'json')), false);
assert.equal('frozenSlug' in f.log.find(c => c.write && c.write.startsWith('site-event:')).value, false, 'draft rename must not keep creation-time frozenSlug');
f = fixture({ 'site-event:draft-test': project() }, { status: 404 });
r = await f.run(onRequestPost, '/admin/api/projects?action=rename&id=draft-test', { name: 'Project rename' });
assert.equal(r.status, 502); assert.equal(f.writes().length, 0);
f = fixture({ 'site-event:draft-test': project({ otraGuideId: '' }) });
r = await f.run(onRequestPost, '/admin/api/projects?action=rename&id=draft-test', { name: 'Local rename' });
assert.equal(r.status, 200); assert.equal(f.posts().length, 0); assert.equal((await f.kv.get('site-event:draft-test', 'json')).title, 'Local rename');
f = fixture({ 'site-event:draft-test': project({ usesExistingOtraGuideEvent: true }) });
r = await f.run(onRequestPost, '/admin/api/projects?action=rename&id=draft-test', { name: 'Borrowed project rename' });
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(f.posts().length, 1);
assert.ok(f.posts()[0].url.endsWith('/event-title/8270/'));
assert.equal((await f.kv.get('site-event:draft-test', 'json')).title, 'Borrowed project rename', 'borrowed keeps a local mirror');
f = fixture({ 'site-event:draft-test': project({ otraGuideId: '', checkoutEventId: '8333' }) });
r = await f.run(onRequestPost, '/admin/api/projects?action=rename&id=draft-test', { name: 'Checkout project rename' });
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(f.posts().length, 1);
assert.ok(f.posts()[0].url.endsWith('/event-title/8333/'));
f = fixture({ 'site-event:draft-test': project({ keepSellingWhileGuidePrivate: true }) });
r = await f.run(onRequestPost, '/admin/api/projects?action=rename&id=draft-test', { name: 'Keep selling rename' });
assert.equal(r.status, 200); assert.equal(f.posts().length, 0);
assert.equal((await f.kv.get('site-event:draft-test', 'json')).title, 'Keep selling rename');
// Binding and all project metadata writers use the title-safe storage boundary.
f = fixture({ 'event:draft-test': override });
await putTitleSafeProject(f.kv, project({ frozenSlug: '', status: 'published' }));
let stored = await f.kv.get('site-event:draft-test', 'json');
assert.equal('title' in stored, false); assert.ok(stored.frozenSlug); assert.equal((await f.kv.get('event:draft-test', 'json')).fields[TITLE_FIELD], undefined);

// POST succeeded but the refresh failed: no local title, explicit saved warning.
for (const options of [{readStatus:401}, {readStatus:403}, {readStatus:404}, {readTimeout:true}, {readMalformed:{}}, {readMalformed:{id:9999,title:'Wrong event'}}]) {
 f=fixture({'site-event:draft-test':project()},options);
 r=await f.run(onRequestPut,'/admin/api/overrides?id=draft-test',titleBody('Confirmed write'));
 assert.equal(r.status,200); assert.equal(r.data.guideTitle,null); assert.equal(r.data.guideTitleUnavailable,true);
 assert.match(r.data.warning,/Title saved in Guide/);
 assert.equal('title' in await f.kv.get('site-event:draft-test','json'),false);
}
// A new request/reload sees Studio changes instead of a process or durable cache.
f=fixture({'site-event:draft-test':project()},{guideTitle:'Studio current title'});
r=await f.run(onRequestGet,'/admin/api/overrides?id=draft-test');
assert.equal(r.data.guideTitle.title,'Studio current title');
r=await f.run(onRequestPut,'/admin/api/overrides?id=draft-test',titleBody('Edited from OT'));
r=await f.run(onRequestGet,'/admin/api/overrides?id=draft-test');
assert.equal(r.data.guideTitle.title,'Edited from OT');
assert.equal((await f.kv.get('event:draft-test','json')).fields[TITLE_FIELD],undefined);

// Project and page lists hydrate owned titles after loading storage, not into storage.
f=fixture({'site-event:draft-test':project()},{guideTitle:'Guide project list title'});
r=await f.run(projectsGet,'/admin/api/projects');
assert.equal(r.data.projects[0].title,'Guide project list title');
assert.equal(r.data.projects[0].claudeDesign.displayTitle,undefined);
assert.equal((await f.kv.get('site-event:draft-test','json')).title,'Old local','GET is read-only');
r=await f.run(pagesGet,'/admin/api/pages');
assert.equal(r.data.pages.find(p=>p.id==='draft-test').title,'Guide project list title');
// Staff iframe payload uses GET title over cached public data/project design.
f=fixture({'site-event:draft-test':project(),'event:draft-test':override},{guideTitle:'Guide preview title'});
r=await f.run(eventGet,'/api/event?id=draft-test');
assert.equal(r.status,200);assert.equal(r.data.title,'Guide preview title');
assert.equal(r.data.design.displayTitle,undefined);assert.equal(r.data.staffPreview,true);
r=await f.run(publicOverrideGet,'/api/override?id=draft-test');
assert.equal(r.status,200);assert.equal(r.data.override.fields[TITLE_FIELD].value,'Guide preview title');
assert.equal((await f.kv.get('event:draft-test','json')).fields[TITLE_FIELD].value,'Old title','ephemeral field never persisted');
// Plain numeric page without an owned OT project does not invent Guide title ownership.
f=fixture({}, {guideTitle:'Guide manual page title'});
r=await f.run(publicOverrideGet,'/api/override?id=8270');
assert.equal(r.data.override, null);
assert.equal(f.writes().length,0);
// Owned numeric page without prior KV override still previews Guide's title.
f=fixture({
  'site-event:draft-bound': project({ id:'draft-bound', status:'published', publishedAt:'2026-11-01T00:00:00Z', otraGuideId:'8270' }),
}, {guideTitle:'Guide manual page title'});
r=await f.run(publicOverrideGet,'/api/override?id=8270');
assert.equal(r.data.override.fields[TITLE_FIELD].value,'Guide manual page title');
assert.equal(f.writes().length,0);
f=fixture({'site-event:draft-test':project(),'event:draft-test':override});
// An unauthenticated response must never use the staff title endpoint.
const readsBefore=f.log.filter(c=>c.url?.includes('/event-slug/')).length;
r=await f.run(eventGet,'/api/event?id=draft-test',undefined,false);
assert.equal(r.status,404,'private draft stays hidden without staff');
assert.equal(f.log.filter(c=>c.url?.includes('/event-slug/')).length,readsBefore);
// Read failures on editor load never show the old local copy.
f=fixture({'site-event:draft-test':project(),'event:draft-test':override},{readStatus:404});
r=await f.run(projectsGet,'/admin/api/projects');
assert.equal(r.data.projects[0].title,'');assert.equal(r.data.projects[0].guideTitleUnavailable,true);
r=await f.run(onRequestGet,'/admin/api/overrides?id=draft-test');
assert.equal(r.data.guideTitle,null);assert.equal(r.data.override.fields[TITLE_FIELD],undefined);
r=await f.run(eventGet,'/api/event?id=draft-test');assert.equal(r.status,502);
// Hydrated project responses remain compatible with private-content optimistic checks.
f=fixture({'site-event:draft-test':project()});
r=await f.run(projectsGet,'/admin/api/projects');
const hydrated=r.data.projects[0];
r=await f.run(onRequestPost,'/admin/api/projects?action=update-content&id=draft-test',{
 expectedProject:hydrated, expected:{description:hydrated.description,claudeDesign:hydrated.claudeDesign}, patch:{bandText:'Updated private content'}
});
assert.equal(r.status,200);assert.equal((await f.kv.get('site-event:draft-test','json')).claudeDesign.bandText,'Updated private content');
assert.equal('title' in await f.kv.get('site-event:draft-test','json'),false);
assert.equal('guideTitle' in await f.kv.get('site-event:draft-test','json'),false);
// Unlinked pages never trigger the Guide title GET; borrowed pages hydrate from Guide.
f=fixture({'site-event:draft-test':project({otraGuideId:''})});r=await f.run(projectsGet,'/admin/api/projects');
assert.equal(r.data.projects[0].title,'Old local');
assert.equal(f.log.filter(c=>c.url?.includes('/event-slug/')).length,0);
f=fixture({'site-event:draft-test':project({usesExistingOtraGuideEvent:true})},{guideTitle:'Borrowed Guide title'});
r=await f.run(projectsGet,'/admin/api/projects');
assert.equal(r.data.projects[0].title,'Borrowed Guide title');
assert.ok(f.log.some(c=>c.url?.includes('/event-slug/8270/')));
// UI helper changes only the selected label; it never writes into override fields.
const html=readFileSync(new URL('../admin/index.html',import.meta.url),'utf8');
const helper=html.slice(html.indexOf('  function applyGuideTitle('),html.indexOf('  function fillForm('));
const ui={renderPageSelectOptions:()=>{},currentOverride:{fields:{}},page:{id:'draft-test',title:'Stale'}};
vm.createContext(ui);vm.runInContext(helper,ui);
ui.applyGuideTitle({guideTitle:{title:'Fresh Guide UI'}},ui.page);
assert.equal(ui.page.title,'Fresh Guide UI');assert.deepEqual(Object.keys(ui.currentOverride.fields),[]);
ui.applyGuideTitle({guideTitleUnavailable:true},ui.page);assert.equal(ui.page.title,'Guide title unavailable');
assert.ok(html.includes('if (selected !== loadingPage) return;'),'late selection reads cannot update another page');
assert.ok(html.includes('if (selected !== savingPage) return data;'),'late save hydration cannot update another selected page');
assert.ok(html.includes('if (selected !== submittedPage) return;'),'late save cannot refresh/close another page editor');

// --- Opus r2 policy edges -------------------------------------------------
{
  const f = fixture({});
  assert.equal(await guideTitleIdForPage(f.kv, '6113'), '');
  assert.equal(await guideTitleIdForPage(f.kv, '8270'), '');
  await f.kv.put('site-event:draft-owned', JSON.stringify(project({ id:'draft-owned', otraGuideId:'8270', usesExistingOtraGuideEvent:false, status:'published' })));
  assert.equal(await guideTitleIdForPage(f.kv, '8270'), '8270');
  await f.kv.put('site-event:draft-borrowed', JSON.stringify(project({ id:'draft-borrowed', otraGuideId:'6113', usesExistingOtraGuideEvent:true, status:'published' })));
  assert.equal(await guideTitleIdForPage(f.kv, '6113'), '6113');
}
{
  const draft = project({ status:'draft', publishedAt:undefined, frozenSlug:undefined, title:'Draft Name' });
  assert.equal('frozenSlug' in projectForStorage(draft), false, 'draft must not mint frozenSlug');
  const published = project({ status:'published', publishedAt:'2026-11-05T12:00:00Z', frozenSlug:undefined, title:'Live Name' });
  assert.ok(projectForStorage(published).frozenSlug, 'published mints frozenSlug');
  const unlistedDraft = project({ status:'draft', publishedAt:undefined, unlisted:true, frozenSlug:'secret-link', title:'Hidden' });
  assert.equal(projectForStorage(unlistedDraft).frozenSlug, 'secret-link', 'unlisted draft keeps reserved short link');

}
{
  assert.deepEqual(
    styleOnlyTitleField({ type:'text', value:'Guide Name', html:'<strong>Guide Name</strong>' }, 'Guide Name'),
    { type:'text', value:'Guide Name', html:'<strong>Guide Name</strong>' }
  );
  assert.equal(styleOnlyTitleField({ type:'text', value:'Other', html:'<strong>Other</strong>' }, 'Guide Name'), null);
  const f = fixture({
    'site-event:draft-test': project({ title:'Current Guide title' }),
    'event:draft-test': { fields: {}, updatedAt:'2026-11-01T12:00:00Z' },
  }, { guideTitle:'Current Guide title' });
  const before = f.posts().length;
  const r = await f.run(onRequestPut, '/admin/api/overrides?id=draft-test', {
    fields: { [TITLE_FIELD]: { type:'text', value:'Current Guide title', html:'<em>Current Guide title</em>' } },
    base: { fields: { [TITLE_FIELD]: { type:'text', value:'Current Guide title' } }, top:{}, updatedAt:null },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(f.posts().length, before, 'format-only must not POST Guide');
  const saved = await f.kv.get('event:draft-test', 'json');
  assert.ok(saved.fields[TITLE_FIELD]?.html?.includes('Current Guide title'));
}
{
  const f = fixture({
    'site-event:draft-test': projectForStorage(project({ status:'published', publishedAt:'2026-11-05T12:00:00Z' })),
  });
  const before = f.writes().length;
  await discardLinkedTitleCopies(f.kv, '8270', { guidePlain:'Current Guide title' });
  assert.equal(f.writes().length, before, 'clean linked copies must not rewrite');
}


// First publish of an owned draft must freeze URL from Guide title, not "Claude Design Event".
{
  const f = fixture({
    'site-event:draft-test': project({ status:'draft', publishedAt:undefined, frozenSlug:undefined, title:'Old local', otraGuideSlug:'8270' }),
  }, { guideTitle:'Francis Sling Book Launch' });
  const r = await f.run(onRequestPost, '/admin/api/projects?action=publish&id=draft-test', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const stored = await f.kv.get('site-event:draft-test', 'json');
  assert.equal(stored.status, 'published');
  assert.ok(stored.frozenSlug && !stored.frozenSlug.includes('claude-design'), stored.frozenSlug);
  assert.match(stored.frozenSlug, /francis-sling-book-launch/);
}

console.log('check-guide-title-ssot-b: all assertions passed (mocked network only)');
