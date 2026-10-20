// Oracle: the admin Edit dropdown (/admin/api/pages) must list ticketed Otra
// Guide events far ahead and staff only ones (Cascada NYE 8257) from ONE staff
// calendar call, skip happy hours, fold recurring occurrences into one entry,
// find unpublished events known from KV through the staff ticketed search,
// survive an upstream outage, cache only good builds, and answer 401 without a
// valid staff session.
// Run: node scripts/check-admin-editor-list.mjs

import { onRequestGet } from '../functions/admin/api/pages.js';

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const STAFF = 'Bearer staff-token';
const base = 'https://backend.test/api';

const calendarRows = [
  // Happy hours: one row per day, never ticketed.
  ...Array.from({ length: 50 }, (_, i) => ({
    id: Number(`2902${100 + i}`), title: '17:00 - HAPPY HOUR', slug: 'happy-hour-cascada',
    start_date: `2026-11-${String((i % 28) + 1).padStart(2, '0')}T17:00:00-04:00`, is_ticketed: false, is_perennial: false,
  })),
  { id: 6845, title: 'Karaoke Night', slug: 'karaoke-night', start_date: '2026-10-21T21:00:00-04:00', is_ticketed: false, is_perennial: false },
  // Recurring ticketed tour: occurrence rows with combined ids and time prefixes.
  { id: 713955501, title: '09:00 - Iguana Ride City Combo Tour', slug: 'iguana-ride-city-combo-tour', start_date: '2026-10-25T09:00:00-04:00', is_ticketed: true, is_perennial: false },
  { id: 713955499, title: '09:00 - Iguana Ride City Combo Tour', slug: 'iguana-ride-city-combo-tour', start_date: '2026-10-21T09:00:00-04:00', is_ticketed: true, is_perennial: false },
  { id: 713955500, title: '14:00 - Iguana Ride City Combo Tour', slug: 'iguana-ride-city-combo-tour', start_date: '2026-10-23T14:00:00-04:00', is_ticketed: true, is_perennial: false },
  // Staff only, far future, ticketed.
  { id: 8257, title: 'Cascada NYE 2027', slug: 'cascada-nye-2027', start_date: '2026-12-31T21:00:00-04:00', is_ticketed: true, is_perennial: false },
  // Ticketed flag but no ticket types on sale: stays out.
  { id: 8100, title: 'No Tickets Yet', slug: 'no-tickets-yet', start_date: '2026-11-15T20:00:00-04:00', is_ticketed: true, is_perennial: false },
  // Featured manual page id must not be duplicated.
  { id: 6113, title: 'Clearboat', slug: 'clearboat', start_date: '2026-10-22T09:00:00-04:00', is_ticketed: true, is_perennial: true },
  // Hidden (archived) event stays hidden.
  { id: 8150, title: 'Archived Party', slug: 'archived-party', start_date: '2026-11-20T20:00:00-04:00', is_ticketed: true, is_perennial: false },
];

const ticketCounts = { 7139: 2, 8088: 3, 8257: 1, 8100: 0, 8150: 1, 8300: 1 };
const adminSearch = {
  8300: { id: 8300, title: 'Unpublished Gala', startDate: '2027-02-14T20:00:00-04:00', isPast: false, isPerennial: false, published: false, tickets: [{ id: 1 }] },
  7567: { id: 7567, title: 'Kaya Kaya Festival', startDate: '2026-09-26T16:00:00-04:00', isPast: true, isPerennial: false, published: true, tickets: [{ id: 2 }] },
  8301: { id: 8301, title: 'Override Without Tickets', startDate: '2027-03-01T20:00:00-04:00', isPast: false, isPerennial: false, published: true, tickets: [] },
};

let calls = [];
let mode = 'ok';
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const auth = new Headers(init.headers || {}).get('authorization');
  calls.push({ url, auth });
  if (url.endsWith('/users/user-role/')) {
    return auth === STAFF ? Response.json({ is_staff_or_admin: true }) : new Response('{}', { status: 401 });
  }
  if (url.includes('/events/nonperennial/calendar/')) {
    if (mode === 'down') return new Response('upstream error', { status: 502 });
    if (mode === 'expired') return Response.json({ detail: 'token expired' }, { status: 401 });
    return Response.json(calendarRows);
  }
  if (url.includes('/events/nonperennial/?')) {
    if (mode === 'down') return new Response('upstream error', { status: 502 });
    // Feed head: promoted and still running events (base ids) plus daily rows.
    if (!url.includes('page=1&')) return Response.json({ count: 900, results: [] });
    return Response.json({ count: 900, results: [
      { id: 8088, title: 'Mike Gatta 50/50/50 Finish Line', start_date: '2026-08-12T18:00:00-04:00', is_ticketed: true, is_perennial: false },
      { id: 8257, title: 'Cascada NYE 2027', start_date: '2026-12-31T21:00:00-04:00', is_ticketed: true, is_perennial: false },
      { id: 2902, title: 'HAPPY HOUR', start_date: '2026-10-20T17:00:00-04:00', is_ticketed: false, is_perennial: false },
    ] });
  }
  let m = url.match(/\/events\/details\/(\d+)\/$/);
  if (m) {
    const id = String(m[1]);
    if (id.startsWith('7139')) return Response.json({ id: 7139, title: 'Iguana Ride City Combo Tour', is_perennial: true });
    return new Response('{}', { status: 404 });
  }
  m = url.match(/\/ticket\/purchase\/tickets\/(\d+)\/$/);
  if (m) return Response.json({ count: ticketCounts[m[1]] || 0 });
  m = url.match(/\/events\/admin-ticketed-search\/\?id=(\d+)$/);
  if (m) {
    if (mode === 'search-down') return new Response('nope', { status: 500 });
    const ev = adminSearch[m[1]];
    return Response.json({ events: ev ? [ev] : [] });
  }
  return new Response('{}', { status: 404 });
};

const store = new Map();
globalThis.caches = {
  default: {
    async match(key) { const hit = store.get(key.url); return hit ? new Response(hit) : undefined; },
    async put(key, response) { store.set(key.url, await response.text()); },
  },
};

const kvData = new Map([
  ['admin:hidden-pages', ['8150']],
  ['site-event:draft-unpub', { title: 'Unpublished Gala design', status: 'draft', otraGuideId: '8300', startDate: '2027-02-14T20:00:00-04:00' }],
  ['event:7567', { fields: {} }],
  ['event:8257', { fields: {} }],
  ['override:8301', { fields: {} }],
]);
const kv = {
  async list({ prefix }) { return { keys: [...kvData.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  async get(key) { return kvData.has(key) ? kvData.get(key) : null; },
};
const env = { OTRA_API_URL: base, OVERRIDES: kv };
const call = async (authorization) => {
  const pending = [];
  const response = await onRequestGet({
    request: new Request('https://tickets.test/admin/api/pages', authorization ? { headers: { authorization } } : {}),
    env,
    waitUntil(promise) { pending.push(promise); },
  });
  await Promise.all(pending);
  return response;
};

// 1. No token and an expired token both answer 401 without touching the feed.
for (const [label, header] of [['missing', ''], ['expired', 'Bearer old-token']]) {
  calls = [];
  const response = await call(header);
  assert(response.status === 401, `${label} token must return 401 (got ${response.status})`);
  assert(!calls.some((c) => c.url.includes('/calendar/')), `${label} token must not reach the calendar feed`);
}

// 2. Happy path.
calls = [];
let response = await call(STAFF);
let payload = await response.json();
assert(response.status === 200, 'staff list must succeed');
const calendarCalls = calls.filter((c) => c.url.includes('/events/nonperennial/calendar/'));
assert(calendarCalls.length === 1, `exactly one calendar call expected (got ${calendarCalls.length})`);
const cal = calendarCalls[0] ? new URL(calendarCalls[0].url) : null;
assert(cal && cal.searchParams.get('category_id') === '339', 'calendar call must filter category 339');
assert(cal && /^\d{4}-\d{2}-\d{2}$/.test(cal.searchParams.get('start') || '') && /^\d{4}-\d{2}-\d{2}$/.test(cal.searchParams.get('end') || ''), 'calendar call must send a start and end date');
if (cal) {
  const spanDays = (new Date(cal.searchParams.get('end')) - new Date(cal.searchParams.get('start'))) / 86400000;
  assert(spanDays >= 360 && spanDays <= 400, `calendar window must cover about a month back and a year ahead (got ${spanDays} days)`);
}
assert(calls.filter((c) => !c.url.endsWith('/users/user-role/')).every((c) => c.auth === STAFF), 'every Otra Guide call must forward the staff Bearer token');

const ids = payload.pages.map((p) => p.id);
const byId = (id) => payload.pages.find((p) => p.id === id);
assert(byId('8257') && byId('8257').title === 'Cascada NYE 2027', 'staff only far future Cascada NYE 8257 must be listed');
assert(byId('8257') && byId('8257').url === '/event.html?id=8257', '8257 must open through event.html?id=8257');
assert(!payload.pages.some((p) => /happy hour|karaoke/i.test(p.title)), 'happy hours and other unticketed rows must not be listed');
assert(!calls.some((c) => /\/ticket\/purchase\/tickets\/(2902|6845)/.test(c.url)), 'unticketed rows must not cost a ticket check');
const iguana = payload.pages.filter((p) => /iguana/i.test(p.title));
assert(iguana.length === 1, `recurring occurrences must fold into one entry (got ${iguana.length})`);
assert(iguana[0] && iguana[0].id === '7139', 'folded entry must use the base event id');
assert(iguana[0] && iguana[0].title === 'Iguana Ride City Combo Tour', 'folded entry must drop the occurrence time prefix');
assert(iguana[0] && iguana[0].startDate === '2026-10-21T09:00:00-04:00', 'folded entry must keep the earliest start');
assert(iguana[0] && iguana[0].type === 'Published tour', 'perennial tour must keep the tour label');
assert(calls.filter((c) => c.url.includes('/events/details/')).length === 1, 'one detail lookup per folded recurring event');
assert(!ids.includes('8100'), 'ticketed flag without ticket types must stay out');
assert(ids.filter((id) => id === '6113').length === 1, 'manual Clearboat page must not be duplicated');
assert(!ids.includes('8150'), 'archived pages must stay hidden');
assert(byId('8300') && byId('8300').title === 'Unpublished Gala', 'unpublished event known from a KV draft must come from the staff ticketed search');
assert(ids.includes('draft-unpub'), 'an unpublished draft keeps its own draft entry');
assert(!ids.includes('7567'), 'past events known from overrides must not be listed');
assert(!ids.includes('8301'), 'override events without tickets must not be listed');
assert(!calls.some((c) => c.url.includes('admin-ticketed-search/?id=8257')), 'events already in the calendar must not be looked up again');
assert(!payload.upstreamError, 'healthy build must not report an upstream error');
const headCalls = calls.filter((c) => /\/events\/nonperennial\/\?/.test(c.url));
assert(headCalls.length === 4 && headCalls.every((c) => /category_id=339&page=[1-4]&page_size=20$/.test(c.url)), 'the old 4 x 20 category feed window must still be read so nothing the old list showed disappears');
assert(byId('8088'), 'still running promoted event from the feed head must be listed even though it started before the calendar window');
assert(ids.filter((id) => id === '8257').length === 1, 'an event in both the calendar and the feed head must appear once');
const nonPerennial = payload.pages.filter((p) => /^\d+$/.test(p.id) && p.type !== 'Manual page');
const tourIndex = nonPerennial.findIndex((p) => p.type === 'Published tour');
assert(tourIndex === -1 || nonPerennial.slice(tourIndex).every((p) => p.type === 'Published tour'), 'tours must sort after dated events');
const totalUpstream = calls.filter((c) => !c.url.endsWith('/users/user-role/')).length;
assert(totalUpstream <= 18, `whole build must stay small (got ${totalUpstream} upstream calls)`);

// 3. A second request inside the TTL is served from cache.
calls = [];
response = await call(STAFF);
payload = await response.json();
assert(response.status === 200 && payload.pages.some((p) => p.id === '8257'), 'cached list must still include 8257');
assert(!calls.some((c) => c.url.includes('/calendar/')), 'second request must be served from the cache');

// 4. Upstream outage: still answers with drafts, manual pages and fallback, flags it, and is not cached.
store.clear();
mode = 'down';
calls = [];
response = await call(STAFF);
payload = await response.json();
assert(response.status === 200, `upstream outage must not break the editor (got ${response.status})`);
assert(payload.pages.some((p) => p.id === '7275') && payload.pages.some((p) => p.id === '6113'), 'manual pages must survive an outage');
assert(payload.pages.some((p) => p.id === 'draft-unpub'), 'drafts must survive an outage');
assert(payload.pages.some((p) => p.id === '8300'), 'fallback lookups still run during a calendar outage');
assert(typeof payload.upstreamError === 'string' && payload.upstreamError, 'outage must be reported as upstreamError');
assert(store.size === 0, 'a failed build must not be cached');
mode = 'ok';
calls = [];
await call(STAFF);
assert(calls.some((c) => c.url.includes('/calendar/')), 'after an outage the next request must rebuild');

// 5. Fallback lookup failure is reported and not cached, list still served.
store.clear();
mode = 'search-down';
response = await call(STAFF);
payload = await response.json();
assert(response.status === 200 && payload.pages.some((p) => p.id === '8257'), 'calendar results must survive a ticketed search failure');
assert(payload.upstreamError, 'ticketed search failure must be reported');
assert(store.size === 0, 'partial build must not be cached');

// 6. Token rejected by the calendar feed mid flight: 401 like other admin endpoints.
store.clear();
mode = 'expired';
response = await call(STAFF);
assert(response.status === 401, `calendar 401 must surface as 401 (got ${response.status})`);
assert(store.size === 0, 'a rejected token must not be cached');

if (failures.length) {
  console.error('check-admin-editor-list FAILED:');
  failures.forEach((failure) => console.error(' - ' + failure));
  process.exit(1);
}
console.log('check-admin-editor-list OK (one staff calendar call, ticketed only, recurring folded, KV fallback, outage safe, cached, 401)');
