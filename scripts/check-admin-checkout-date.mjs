// Oracle: an already-edited, non-recurring event exposes an Edit date control
// in the checkout modal and uses the existing full date-sync endpoint.
// Run: node scripts/check-admin-checkout-date.mjs

import fs from 'node:fs';
import { URL } from 'node:url';
import { onRequestPut } from '../functions/admin/api/events.js';

const adminHtml = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

function extractFunction(name, source = adminHtml) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  return '';
}

const stateSource = extractFunction('checkoutDateState');
const formatSource = extractFunction('formatShortDate');
assert(stateSource, 'checkoutDateState must exist');
assert(formatSource, 'formatShortDate must exist');
const checkoutDateState = stateSource
  ? Function(`${formatSource}; ${stateSource}; return checkoutDateState;`)()
  : null;

const modified = checkoutDateState?.({
  startDate: '2026-09-06T17:00:00-04:00',
  isPerennial: false,
});
assert(modified?.day === '2026-09-06', 'the calendar must receive the event day');
assert(modified?.editable === true, 'an already-modified one-off event must expose Edit date');
assert(/Sep.*6.*2026/i.test(modified?.summary || ''), 'the modal must show the current date before editing');

const recurring = checkoutDateState?.({
  startDate: '2025-12-28T17:00:00-04:00',
  isPerennial: true,
});
assert(recurring?.editable === false, 'a recurring event must not expose a misleading single-day editor');
assert(/Recurring event/.test(recurring?.summary || ''), 'recurring events must explain where their schedule lives');
assert(
  checkoutDateState?.({ startDate: '2026-09-06T17:00:00-04:00', isRecurring: true }).editable === false,
  'recurring-series events must also keep their schedule in the tickets dashboard'
);
assert(checkoutDateState?.({ startDate: '', isPerennial: false }).editable === false, 'an invalid date must not open the editor');

for (const id of ['editCheckoutDateBtn', 'checkoutDateEditor', 'checkoutEventDate', 'saveCheckoutDateBtn']) {
  assert(adminHtml.includes(`id="${id}"`), `${id} must exist in the checkout modal`);
}
const saveSource = extractFunction('saveCheckoutDate');
assert(/startDate:\s*day/.test(saveSource), 'Edit date must submit the selected YYYY-MM-DD value');
assert(/renderPageSelectOptions/.test(saveSource), 'a saved date must refresh duplicate-name dropdown labels');
assert(/refreshPreview\(\)/.test(saveSource), 'a saved date must refresh the edited event preview');

const calls = [];
const puts = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  if (url.endsWith('/users/user-role/')) return Response.json({ is_staff_or_admin: true });
  if (url.endsWith('/events/details/7517/')) {
    return Response.json({
      id: 7517,
      title: 'Sunday Social Club',
      start_date: '2026-09-06T12:00:00-04:00',
      end_date: '2026-09-06T21:00:00-04:00',
      is_perennial: false,
      is_recurring: false,
    });
  }
  if (url.endsWith('/otra-tickets/media/event-slug/7517/')) return Response.json({ slug: 'sunday-social-club' });
  if (url.endsWith('/events/update/sunday-social-club/')) {
    const body = JSON.parse(options.body);
    return Response.json({ start_date: body.start_date, end_date: body.end_date });
  }
  if (url.endsWith('/ticket/purchase/tickets/7517/')) {
    return Response.json({ results: [{ id: 301 }, { id: 302 }] });
  }
  if (/\/ticket\/create\/tickets\/7517\/(301|302)\/$/.test(url)) return Response.json({ ok: true });
  if (url.includes('/api/homepage-events?fresh=1')) return Response.json({ ok: true });
  return new Response('{}', { status: 404 });
};

const directKey = 'site-event:draft-modified-sunday';
const project = {
  otraGuideId: '7517',
  startDate: '2026-09-06T12:00:00-04:00',
  endDate: '2026-09-06T21:00:00-04:00',
  claudeDesign: { meta: ['Sun, September 6, 2026', '12PM to 9PM'] },
};
const kv = {
  async get(key) { return key === directKey ? project : null; },
  async put(key, value) { puts.push({ key, value: JSON.parse(value) }); },
  async list() { return { keys: [], list_complete: true }; },
};

try {
  const response = await onRequestPut({
    request: new Request('https://tickets.test/admin/api/events', {
      method: 'PUT',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 7517, draftId: 'draft-modified-sunday', startDate: '2026-09-20' }),
    }),
    env: { OTRA_API_URL: 'https://backend.test/api', OVERRIDES: kv },
    waitUntil() {},
  });
  const payload = await response.json();
  assert(response.status === 200, 'checkout Edit date request must succeed');
  assert(payload.event?.start_date === '2026-09-20T12:00:00-04:00', 'date sync must preserve the original start time');
  assert(payload.event?.end_date === '2026-09-20T21:00:00-04:00', 'date sync must preserve the original end time and duration');
  const eventPatch = calls.find((call) => call.url.endsWith('/events/update/sunday-social-club/'));
  assert(eventPatch?.body?.start_date === '2026-09-20T12:00:00-04:00', 'the real Otra Guide event must move to the selected day');
  const salePatches = calls.filter((call) => /\/ticket\/create\/tickets\/7517\/(301|302)\/$/.test(call.url));
  assert(salePatches.length === 2, 'all ticket sale windows must move with the date');
  assert(salePatches.every((call) => call.body?.sale_end_time === '2026-09-20T12:00:00-04:00'), 'ticket sales must remain open until the new start');
  assert(puts.length === 1 && puts[0].key === directKey, 'the already-modified draft must be updated directly');
  assert(puts[0]?.value?.startDate === '2026-09-20T12:00:00-04:00', 'the event page/card copy must receive the new date');
} finally {
  globalThis.fetch = originalFetch;
}

if (failures.length) {
  console.error('check-admin-checkout-date FAILED:');
  failures.forEach((failure) => console.error(' - ' + failure));
  process.exit(1);
}

console.log('check-admin-checkout-date OK (modal state + full date propagation)');
