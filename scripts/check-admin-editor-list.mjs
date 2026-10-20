// Oracle: the admin Edit dropdown (/admin/api/pages) must list ticketed Otra
// Guide events far ahead and staff only ones (Cascada NYE 8257) from one staff
// calendar call plus the old 4 x 20 category window, skip happy hours, fold
// recurring occurrences into one entry, judge every event through the staff
// ticketed search (ticket types count even before the sale opens), find
// unpublished events known from KV, survive upstream outages, cache only good
// builds, and answer 401 without a valid staff session.
// Run: node scripts/check-admin-editor-list.mjs

import { onRequestGet } from '../functions/admin/api/pages.js';

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const STAFF = 'Bearer staff-token';
const base = 'https://backend.test/api';
// Fixture dates are relative to now so the check never ages out.
const at = (days, hour = 12) => {
  const d = new Date(Date.now() + days * 86400000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

const calendarRows = [
  // Happy hours: one row per day, never ticketed.
  ...Array.from({ length: 50 }, (_, i) => ({
    id: Number(`2902${100 + i}`), title: '17:00 - HAPPY HOUR', slug: 'happy-hour-cascada',
    start_date: at(1 + (i % 28), 21), is_ticketed: false, is_perennial: false,
  })),
  { id: 6845, title: 'Karaoke Night', slug: 'karaoke-night', start_date: at(2, 1), is_ticketed: false, is_perennial: false },
  // Recurring ticketed tour: occurrence rows with combined ids and time prefixes.
  { id: 713955501, title: '09:00 - Iguana Ride City Combo Tour', slug: 'iguana-ride-city-combo-tour', start_date: at(5, 13), is_ticketed: true, is_perennial: false },
  { id: 713955499, title: '09:00 - Iguana Ride City Combo Tour', slug: 'iguana-ride-city-combo-tour', start_date: at(1, 13), is_ticketed: true, is_perennial: false },
  { id: 713955500, title: '14:00 - Iguana Ride City Combo Tour', slug: 'iguana-ride-city-combo-tour', start_date: at(3, 18), is_ticketed: true, is_perennial: false },
  // Recurring ticketed flag but no ticket types: the title search comes back
  // short without it, so no detail call (page view) is spent on it.
  { id: 815501, title: '19:00 - Ticketless Weekly', slug: 'ticketless-weekly', start_date: at(6, 22), is_ticketed: true, is_perennial: false },
  // Recurring event whose title search hits the 20 row cap without its slug: detail fallback.
  { id: 742011, title: '20:00 - Noche de Salsa', slug: 'salsa-night-weekly', start_date: at(4, 0), is_ticketed: true, is_perennial: false },
  // Staff only, far future, ticketed.
  { id: 8257, title: 'Cascada NYE 2027', slug: 'cascada-nye-2027', start_date: at(72, 1), is_ticketed: true, is_perennial: false },
  // Ticketed flag but no ticket types at all: stays out.
  { id: 8100, title: 'No Tickets Yet', slug: 'no-tickets-yet', start_date: at(26), is_ticketed: true, is_perennial: false },
  // Ticket types exist but the sale opens later: editable, so listed.
  { id: 8110, title: 'Sale Opens Later', slug: 'sale-opens-later', start_date: at(90), is_ticketed: true, is_perennial: false },
  // Featured manual page id must not be duplicated.
  { id: 6113, title: 'Clearboat', slug: 'clearboat', start_date: at(2), is_ticketed: true, is_perennial: true },
  // Same title, different unique slugs, and rows without a slug: never merged.
  { id: 8201, title: 'Sunday Social Club', slug: 'sunday-social-club', start_date: at(12), is_ticketed: true, is_perennial: false },
  { id: 8202, title: 'Sunday Social Club', slug: 'sunday-social-club-2', start_date: at(19), is_ticketed: true, is_perennial: false },
  { id: 8211, title: 'No Slug A', slug: null, start_date: at(13), is_ticketed: true, is_perennial: false },
  { id: 8212, title: 'No Slug B', slug: null, start_date: at(14), is_ticketed: true, is_perennial: false },
  // Ended inside the one month lookback: not listed, no lookup.
  { id: 8050, title: 'Ended Party', slug: 'ended-party', start_date: at(-10, 0), end_date: at(-10, 5), is_ticketed: true, is_perennial: false },
  // Hidden (archived) event stays hidden.
  { id: 8150, title: 'Archived Party', slug: 'archived-party', start_date: at(31), is_ticketed: true, is_perennial: false },
];

const tickets = [{ id: 1, name: 'GA', isActive: true }];
const records = new Map([
  [7139, { id: 7139, title: 'Iguana Ride City Combo Tour', slug: 'iguana-ride-city-combo-tour', startDate: at(-200), isPast: true, isPerennial: true, tickets }], // Django isPast reads parent dates only
  [7420, { id: 7420, title: 'Salsa Night Weekly', slug: 'salsa-night-weekly', startDate: at(-100), isPast: true, isPerennial: false, tickets }], // open ended weekly series, no end_date
  [8257, { id: 8257, title: 'Cascada NYE 2027', slug: 'cascada-nye-2027', startDate: at(72, 1), isPast: false, isPerennial: false, tickets }],
  [8100, null],
  [8110, { id: 8110, title: 'Sale Opens Later', slug: 'sale-opens-later', startDate: at(90), isPast: false, isPerennial: false, tickets: [{ id: 3, saleStartDate: at(60) }] }],
  [8201, { id: 8201, title: 'Sunday Social Club', slug: 'sunday-social-club', startDate: at(12), isPast: false, tickets }],
  [8202, { id: 8202, title: 'Sunday Social Club', slug: 'sunday-social-club-2', startDate: at(19), isPast: false, tickets }],
  [8211, { id: 8211, title: 'No Slug A', startDate: at(13), isPast: false, tickets }],
  [8212, { id: 8212, title: 'No Slug B', startDate: at(14), isPast: false, tickets }],
  [8050, { id: 8050, title: 'Ended Party', slug: 'ended-party', startDate: at(-10, 0), isPast: true, tickets }],
  [8150, { id: 8150, title: 'Archived Party', slug: 'archived-party', startDate: at(31), isPast: false, tickets }],
  [8088, { id: 8088, title: 'Mike Gatta 50/50/50 Finish Line', slug: 'mike-gatta', startDate: at(-69), isPast: false, tickets }],
  [8300, { id: 8300, title: 'Unpublished Gala', startDate: at(117), isPast: false, isPerennial: false, published: false, tickets }],
  [7567, { id: 7567, title: 'Kaya Kaya Festival', startDate: at(-24), isPast: true, isPerennial: false, published: true, tickets }],
  [8301, null],
  [8302, { id: 8302, title: 'Saved Perennial Tour', startDate: at(-300), isPast: true, isPerennial: true, tickets }],
]);

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
    if (mode === 'many') return Response.json(Array.from({ length: 305 }, (_, i) => ({
      id: 90000 + i, title: `Event ${i}`, slug: `event-${i}`, start_date: at(1 + i), is_ticketed: true, is_perennial: false,
    })));
    return Response.json(calendarRows);
  }
  if (url.includes('/events/nonperennial/?')) {
    if (mode === 'down') return new Response('upstream error', { status: 502 });
    // Django answers 404 for a page past the end of a short feed.
    if (url.includes('page=4&')) return Response.json({ detail: 'Invalid page.' }, { status: 404 });
    if (!url.includes('page=1&')) return Response.json({ count: 900, results: [] });
    return Response.json({ count: 900, results: [
      { id: 8088, title: 'Mike Gatta 50/50/50 Finish Line', start_date: at(-69), is_ticketed: true, is_perennial: false },
      { id: 8257, title: 'Cascada NYE 2027', start_date: at(72, 1), is_ticketed: true, is_perennial: false },
      { id: 2902, title: 'HAPPY HOUR', start_date: at(0, 21), is_ticketed: false, is_perennial: false },
    ] });
  }
  let m = url.match(/\/events\/details\/(\d+)\/$/);
  if (m) {
    if (mode === 'details-down') return new Response('bad gateway', { status: 502 });
    if (m[1] === '742011') return Response.json({ id: 7420, title: 'Salsa Night Weekly', is_perennial: false });
    return new Response('{}', { status: 404 });
  }
  if (url.includes('/ticket/purchase/tickets/')) throw new Error('the purchase window must not decide editor membership');
  m = url.match(/\/events\/admin-ticketed-search\/\?id=(\d+)$/);
  if (m) {
    if (mode === 'search-down' || (mode === 'id-down' && m[1] === '8257')) return new Response('nope', { status: 500 });
    const ev = records.get(Number(m[1]));
    return Response.json({ events: ev ? [ev] : [] });
  }
  m = url.match(/\/events\/admin-ticketed-search\/\?q=(.+)$/);
  if (m) {
    if (mode === 'search-down') return new Response('nope', { status: 500 });
    const q = decodeURIComponent(m[1]).toLowerCase();
    if (q === 'noche de salsa') return Response.json({ events: Array.from({ length: 20 }, (_, i) => ({ id: 60000 + i, title: `Noche de Salsa ${i}`, slug: `noche-${i}`, isPast: false, tickets })) });
    return Response.json({ events: [...records.values()].filter((ev) => ev && ev.title.toLowerCase().includes(q)) });
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
  ['site-event:draft-unpub', { title: 'Unpublished Gala design', status: 'draft', otraGuideId: '8300', startDate: at(117) }],
  ['event:7567', { fields: {} }],
  ['event:8257', { fields: {} }],
  ['override:8301', { fields: {} }],
  ['override:8302', { fields: {} }],
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
const headCalls = calls.filter((c) => /\/events\/nonperennial\/\?/.test(c.url));
assert(headCalls.length === 4 && headCalls.every((c) => /category_id=339&page=[1-4]&page_size=20$/.test(c.url)), 'the old 4 x 20 category window must still be read so nothing the old list showed disappears');

const ids = payload.pages.map((p) => p.id);
const byId = (id) => payload.pages.find((p) => p.id === id);
assert(byId('8257') && byId('8257').title === 'Cascada NYE 2027', 'staff only far future Cascada NYE 8257 must be listed');
assert(byId('8257') && byId('8257').url === '/event.html?id=8257', '8257 must open through event.html?id=8257');
assert(ids.filter((id) => id === '8257').length === 1, 'an event in both the calendar and the category feed must appear once');
assert(!payload.pages.some((p) => /happy hour|karaoke/i.test(p.title)), 'happy hours and other unticketed rows must not be listed');
assert(!calls.some((c) => /(2902|6845)/.test(c.url.split('/api/')[1] || '') && c.url.includes('admin-ticketed-search')), 'unticketed rows must not cost a lookup');
const iguana = payload.pages.filter((p) => /iguana/i.test(p.title));
assert(iguana.length === 1, `recurring occurrences must fold into one entry (got ${iguana.length})`);
assert(iguana[0] && iguana[0].id === '7139', 'folded entry must use the base event id');
assert(iguana[0] && iguana[0].title === 'Iguana Ride City Combo Tour', 'folded entry must drop the occurrence time prefix');
assert(iguana[0] && iguana[0].startDate === at(1, 13), 'folded entry must keep the earliest start');
assert(iguana[0] && iguana[0].type === 'Published tour', 'perennial tour must keep the tour label');
assert(byId('7420') && byId('7420').title === 'Salsa Night Weekly', 'a recurring event the capped title search misses must resolve through the detail fallback');
const detailCalls = calls.filter((c) => c.url.includes('/events/details/'));
assert(detailCalls.length === 1 && detailCalls[0].url.endsWith('/742011/'), 'the detail endpoint (which records page views) is only a fallback, never for a conclusive search');
assert(!ids.includes('815501') && !payload.pages.some((p) => /ticketless/i.test(p.title)), 'a recurring event without ticket types stays out');
assert(!ids.includes('8100'), 'an event without ticket types must stay out');
assert(byId('8110'), 'an event whose ticket sale opens later must be editable');
assert(byId('8201') && byId('8202'), 'same title events with different slugs must stay separate');
assert(byId('8211') && byId('8212'), 'rows without a slug must stay separate');
assert(!ids.includes('8050') && !calls.some((c) => c.url.endsWith('?id=8050')), 'an event that already ended must not be listed or looked up');
assert(ids.filter((id) => id === '6113').length === 1, 'manual Clearboat page must not be duplicated');
assert(!ids.includes('8150'), 'archived pages must stay hidden');
assert(byId('8088'), 'still running promoted event from the category feed must be listed even though it started before the calendar window');
assert(byId('8300') && byId('8300').title === 'Unpublished Gala', 'unpublished event known from a KV draft must come from the staff ticketed search');
assert(ids.includes('draft-unpub'), 'an unpublished draft keeps its own draft entry');
assert(!ids.includes('7567'), 'past events known from overrides must not be listed');
assert(!ids.includes('8301'), 'override events without tickets must not be listed');
assert(ids.includes('8302'), 'a saved perennial never counts as past (matches isPastPayload)');
assert(ids.includes('7420') && ids.includes('7139'), 'open ended recurring series and perennials started in the past stay listed even when Django isPast reads true');
{
  const q = calls.filter((c) => /admin-ticketed-search\/\?q=/.test(c.url)).map((c) => c.url);
  assert(q.length === new Set(q).size, 'each title is searched once per build');
}
assert(calls.filter((c) => c.url.endsWith('?id=8257')).length === 1, 'each event is looked up once per build');
assert(!calls.some((c) => c.url.endsWith('?id=7139')), 'an event found by the title search is not looked up again');
assert(!payload.upstreamError, `healthy build must not report an upstream error (got ${payload.upstreamError})`);
const dated = payload.pages.filter((p) => /^\d+$/.test(p.id) && p.type !== 'Manual page');
const tourIndex = dated.findIndex((p) => p.type === 'Published tour');
assert(tourIndex === -1 || dated.slice(tourIndex).every((p) => p.type === 'Published tour'), 'tours must sort after dated events');
const totalUpstream = calls.filter((c) => !c.url.endsWith('/users/user-role/')).length;
assert(totalUpstream <= 26, `whole build must stay small (got ${totalUpstream} upstream calls)`);

// 3. A second request inside the TTL is served from cache.
calls = [];
response = await call(STAFF);
payload = await response.json();
assert(response.status === 200 && payload.pages.some((p) => p.id === '8257'), 'cached list must still include 8257');
assert(!calls.some((c) => c.url.includes('/calendar/')), 'second request must be served from the cache');

// 4. Upstream outage: drafts, manual pages and fallback survive, flagged, not cached.
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

// 5. Lookup failures are outages, not "no tickets": reported, never cached.
for (const failing of ['id-down', 'search-down', 'details-down']) {
  store.clear();
  mode = failing;
  response = await call(STAFF);
  payload = await response.json();
  assert(response.status === 200, `${failing}: editor must still load`);
  assert(payload.upstreamError, `${failing}: must be reported as upstreamError`);
  assert(store.size === 0, `${failing}: partial build must not be cached`);
  if (failing === 'id-down') assert(payload.pages.some((p) => p.id === '8201'), 'id-down: other events still listed');
}

// 6. More eligible events than the cap: reported, and since a rebuild would cut
// the same events the build is cached, with the note kept on cache hits.
store.clear();
mode = 'many';
calls = [];
response = await call(STAFF);
payload = await response.json();
assert(response.status === 200 && /truncated/.test(payload.upstreamError || ''), 'a capped list must say it was truncated');
assert(calls.filter((c) => /admin-ticketed-search\/\?id=\d+$/.test(c.url) && !/id=(8300|7567|8301|8302)$/.test(c.url)).length === 300, 'lookups must stop at the cap (KV fallback lookups aside)');
assert(store.size === 1, 'a deterministic cut may be cached');
response = await call(STAFF);
payload = await response.json();
assert(/truncated/.test(payload.upstreamError || ''), 'the truncation note must survive a cache hit');

// 7. Token rejected by the calendar feed mid flight: 401 like other admin endpoints.
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
console.log('check-admin-editor-list OK (staff calendar plus old window, ticketed only, recurring folded, KV fallback, outage safe, cached, 401)');
