// Oracle: Edit checkout can delete a ticket type on Otra Guide safely.
// The delete is refused (and Otra Guide is never called) without staff, the
// exact name, or when tickets were sold; Otra Guide refusing or not offering
// the delete changes nothing; a real delete drops the type from the bound
// Otra Tickets pages and moves later rate-row page edits up one.
// Everything runs against a mocked Otra Guide (fake event 990001).
// Run: node scripts/check-admin-ticket-type-delete.mjs

import fs from 'node:fs';
import { URL } from 'node:url';
import { claimLock, draftRateRow, listPendingDeletes, listedSoldCount, liveRowsStillMatch, nextVersion, onRequestDelete, optionalCount, releaseLock, shiftRateFields, shiftRateOverrides, strictId, withoutTicketType } from '../functions/admin/api/events.js';
import { coversDraft, mergeOverrideDocs } from '../functions/_lib/page-override.js';

const adminHtml = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const EVENT = 990001;
let guide;
let publicRemaining;
let offSale = new Set();
let wrongEventEcho = false;
let guideDeleteMode;
let downAfterDelete = false;
let partialAfterDelete = false;
let publicOnlyAfterDelete = false;
let rateDown = false;
let staffSearchDown = false;
let calls;
function resetGuide() {
  guide = [
    { id: 11, name: 'Single ticket', price: '500.00', quantity: 130, remainingQuantity: 130, currency: 'XCG' },
    { id: 12, name: 'Table of 12', price: '6000.00', quantity: 156, remainingQuantity: 156, currency: 'XCG' },
    { id: 13, name: 'Table of 10', price: '5000.00', quantity: 156, remainingQuantity: 156, currency: 'XCG' },
  ];
  publicRemaining = {};
  offSale = new Set();
  guideDeleteMode = 'ok';
  downAfterDelete = false;
  partialAfterDelete = false;
  publicOnlyAfterDelete = false;
  rateDown = false;
  staffSearchDown = false;
  calls = [];
}

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const method = options.method || 'GET';
  calls.push({ url, method });
  if (url.endsWith('/users/user-role/')) {
    return Response.json({ is_staff_or_admin: options.headers?.authorization === 'Bearer staff' });
  }
  if (downAfterDelete && calls.some((c) => c.method === 'DELETE') && method === 'GET' && !url.includes('/users/')) {
    return Response.json({ detail: 'down' }, { status: 503 });
  }
  const afterDelete = calls.some((c) => c.method === 'DELETE');
  if (partialAfterDelete && afterDelete && method === 'GET') {
    // The staff search and the rate list fail, the event details answer.
    if (url.includes('/events/admin-ticketed-search/')) return Response.json({ events: [] });
    if (url.includes('/ticket/purchase/tickets/')) return Response.json({ detail: 'down' }, { status: 503 });
  }
  if (publicOnlyAfterDelete && afterDelete && url.includes('/events/admin-ticketed-search/')) {
    // Only the public list answers, and it hides type 12 (its sale just ended).
    offSale.add(12);
    return Response.json({ events: [] });
  }
  if (staffSearchDown && url.includes('/events/admin-ticketed-search/')) return Response.json({ events: [] });
  if (rateDown && url.includes('/ticket/purchase/tickets/')) return Response.json({ detail: 'down' }, { status: 503 });
  if (url.includes('/events/admin-ticketed-search/')) {
    const id = new URL(url).searchParams.get('id');
    if (id && id !== String(EVENT) && !wrongEventEcho) return Response.json({ events: [] });
    return Response.json({ events: [{ id: EVENT, title: 'Disposable test gala', isTicketed: true, tickets: guide }] });
  }
  if (url.endsWith(`/events/details/${EVENT}/`)) return Response.json({ id: EVENT, title: 'Disposable test gala' });
  if (url.includes('/events/details/') || url.includes('/ticket/purchase/tickets/')) {
    if (!url.includes(String(EVENT))) return Response.json({ detail: 'Not found.' }, { status: 404 });
  }
  if (url.endsWith(`/ticket/purchase/tickets/${EVENT}/`)) {
    return Response.json({ results: guide.filter((t) => !offSale.has(t.id)).map((t) => ({ id: t.id, name: t.name, quantity: t.quantity, remaining_quantity: t.id in publicRemaining ? publicRemaining[t.id] : t.remainingQuantity })) });
  }
  const del = url.match(new RegExp(`/ticket/create/tickets/${EVENT}/(\\d+)/$`));
  if (del && method === 'DELETE') {
    if (guideDeleteMode === 'missing') return Response.json({ detail: 'Method "DELETE" not allowed.' }, { status: 405 });
    if (guideDeleteMode === 'sold') return Response.json({ error: 'Cannot delete ticket type. 3 tickets have already been sold.' }, { status: 400 });
    if (guideDeleteMode === 'refused') return Response.json({ detail: 'You do not have permission to perform this action.' }, { status: 400 });
    if (guideDeleteMode === 'phantom') return new Response(null, { status: 204 });
    if (guideDeleteMode === 'boom') return Response.json({ detail: 'server error' }, { status: 500 });
    if (guideDeleteMode === 'timeout') throw new DOMException('timed out', 'TimeoutError');
    if (guideDeleteMode === 'lateboom') {
      guide = guide.filter((t) => String(t.id) !== del[1]);
      return Response.json({ detail: 'server error' }, { status: 500 });
    }
    guide = guide.filter((t) => String(t.id) !== del[1]);
    return new Response(null, { status: 204 });
  }
  if (url.includes('/users/')) return Response.json({ email: 'qa@example.test' });
  return Response.json({}, { status: 404 });
};

function makeKv(entries = {}) {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    failPut: null,
    async get(key, type) { const v = store.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) {
      if (this.failPut && this.failPut(key, value)) { this.failPut = null; throw new Error('kv down'); }
      store.set(key, value);
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
// A missing key fails with its name instead of JSON.parse("undefined").
const read = (kv, key) => {
  const value = kv.store.get(key);
  if (value === undefined) throw new Error(`KV key ${key} is missing`);
  return JSON.parse(value);
};

function boundProject(id) {
  return {
    id, otraGuideId: EVENT,
    ticketTypeIds: [11, 12, 13],
    ticketQuantities: [130, 156, 156],
    claudeDesign: { rates: [{ name: 'Single ticket' }, { name: 'Table of 12' }, { name: 'Table of 10' }] },
  };
}
const rateKey = (n, c = 2) => `text:main > #evRates > div:nth-of-type(${n}) > div:nth-of-type(${c})`;

async function call(body, { token = 'staff', kv = makeKv(), noKv = false } = {}) {
  const request = new Request('https://otratickets.test/admin/api/events', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const response = await onRequestDelete({ request, env: noKv ? {} : { OVERRIDES: kv }, waitUntil() {} });
  return { status: response.status, data: await response.json(), kv };
}
const guideDeletes = () => calls.filter((c) => c.method === 'DELETE').length;
const good = { eventId: EVENT, ticketTypeId: 12, confirmName: 'Table of 12', draftId: 'draft-qa-1' };

// Unit pieces.
assert(listedSoldCount({ quantity: 156, remaining_quantity: 153 }) === 3, 'sold = quantity - remaining');
for (const row of [null, { quantity: 156, remaining_quantity: null }, { quantity: 0, remaining_quantity: 0 }, { quantity: 156, remaining_quantity: 157 }]) {
  assert(listedSoldCount(row) === null, `a row without a usable count reads unknown (${JSON.stringify(row)})`);
}
assert(optionalCount(null) === null && optionalCount('') === null && optionalCount(undefined) === null && optionalCount(0) === 0 && optionalCount('7') === 7 && optionalCount(-1) === null,
  'a missing count stays unknown instead of reading as 0');
const spliced = withoutTicketType(boundProject('draft-x'), 12);
assert(JSON.stringify(spliced.ticketTypeIds) === '[11,13]', 'ids lose the deleted type');
assert(JSON.stringify(spliced.ticketQuantities) === '[130,156]', 'quantities stay aligned with ids');
assert(spliced.claudeDesign.rates.map((r) => r.name).join('|') === 'Single ticket|Table of 10', 'rates stay aligned with ids');
assert(withoutTicketType(boundProject('draft-x'), 99) === null, 'a project without the type is left alone');
const shifted = shiftRateFields({ [rateKey(1)]: 'a', [rateKey(2)]: 'b', [rateKey(3)]: 'c', 'text:h1': 'd' }, 2).fields;
assert(shifted[rateKey(1)] === 'a' && shifted[rateKey(2)] === 'c' && !(rateKey(3) in shifted) && shifted['text:h1'] === 'd',
  'rate-row edits: deleted row dropped, later rows move up, others untouched');

// 1. No staff session.
resetGuide();
let r = await call(good, { token: 'nope' });
assert(r.status === 401 && guideDeletes() === 0, 'non-staff is refused before Otra Guide is called');

// 2. Missing / wrong confirm name.
resetGuide();
r = await call({ ...good, confirmName: 'table of 12' });
assert(r.status === 400 && /exact ticket name/.test(r.data.error) && /Nothing was deleted/.test(r.data.error) && guideDeletes() === 0,
  'a wrong typed name is refused and says nothing was deleted');
r = await call({ ...good, confirmName: '' });
assert(r.status === 400 && guideDeletes() === 0, 'a missing typed name is refused');

// 3. Ticket not on the event.
resetGuide();
r = await call({ ...good, ticketTypeId: 77 });
assert(r.status === 409 && /no longer on this event/.test(r.data.error) && guideDeletes() === 0, 'a type from another event is refused');

// 4. Sold > 0 is blocked with the count, Otra Guide never called.
resetGuide();
guide[1].remainingQuantity = 153;
r = await call(good);
assert(r.status === 409 && r.data.code === 'ticket_type_sold' && r.data.sold === 3 && /3 sold tickets/.test(r.data.error) && guideDeletes() === 0,
  'sold tickets block the delete with the count');

// 4b. The staff search reports no remaining count (Otra Guide sends null);
// the public rate list count still blocks a sold type.
resetGuide();
guide[1].remainingQuantity = null;
publicRemaining = { 12: 150 };
r = await call(good);
assert(r.status === 409 && r.data.code === 'ticket_type_sold' && r.data.sold === 6 && guideDeletes() === 0,
  'sold count from the public rate list blocks the delete when the staff search has none');

// 4b2. No count (off sale, so missing from the public list, or no quantity) -> fail closed, Otra Guide never called.
for (const missing of [{ remainingQuantity: null }, { quantity: null }, { quantity: 0 }, { offSale: true }, { overRemaining: true }]) {
  resetGuide();
  if (missing.offSale) offSale.add(12);
  else if (missing.overRemaining) publicRemaining = { 12: 200 };
  else Object.assign(guide[1], missing);
  r = await call(good);
  assert(r.status === 409 && r.data.code === 'ticket_type_sold_unknown' && /Nothing was deleted/.test(r.data.error) && guideDeletes() === 0,
    `an unknown sold count blocks the delete without calling Otra Guide (${JSON.stringify(missing)}, got ${r.status} ${JSON.stringify(r.data)})`);
}

// 4c. Another event id never reaches the Otra Guide delete, even if the
// staff search answers with a different event than the one asked for.
resetGuide();
r = await call({ ...good, eventId: 7567 });
assert(r.status === 404 && guideDeletes() === 0, 'an unknown event id never reaches the Otra Guide delete');
wrongEventEcho = true;
r = await call({ ...good, eventId: 7567 });
wrongEventEcho = false;
assert(r.status === 404 && guideDeletes() === 0, 'a search answer for another event is refused');

// 4d. Bad ids are refused before any Otra Guide call besides the staff check.
resetGuide();
r = await call({ ...good, ticketTypeId: 'abc' });
assert(r.status === 400 && guideDeletes() === 0, 'a non numeric ticket type id is refused');
r = await call({ ...good, eventId: 0 });
assert(r.status === 400 && guideDeletes() === 0, 'a missing event id is refused');

// 5. Last ticket type is refused.
resetGuide();
guide = [guide[0]];
r = await call({ ...good, ticketTypeId: 11, confirmName: 'Single ticket' });
assert(r.status === 400 && /at least one ticket type/.test(r.data.error) && guideDeletes() === 0, 'the last ticket type cannot be deleted');

// 6. Otra Guide refuses (sold on its side) -> 409, nothing changed.
resetGuide();
guideDeleteMode = 'sold';
let kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1'), 'event:draft-qa-1': { fields: { [rateKey(3)]: { type: 'text', value: '5000' } } } });
r = await call(good, { kv });
assert(r.status === 409 && r.data.code === 'ticket_type_sold' && /3 tickets have already been sold/.test(r.data.error), 'Otra Guide sold refusal is shown');
assert(read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3 && rateKey(3) in read(kv, 'event:draft-qa-1').fields, 'a refused delete changes no page');

// 7. Otra Guide has no delete route yet -> 501, nothing changed.
resetGuide();
guideDeleteMode = 'missing';
kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1') });
r = await call(good, { kv });
assert(r.status === 501 && r.data.code === 'guide_delete_unavailable' && /Nothing was deleted/.test(r.data.error), 'a missing Guide route is a clear 501');
assert(read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3, 'a 501 changes no page');

// 7b. Otra Guide refuses for another reason -> 409 that is not labelled sold.
resetGuide();
guideDeleteMode = 'refused';
r = await call(good);
assert(r.status === 409 && r.data.code === 'guide_refused' && /Nothing was deleted/.test(r.data.error), 'a non sold Guide refusal is not labelled sold');

// 7c. Otra Guide says OK but the type is still there -> 502, no page touched.
resetGuide();
guideDeleteMode = 'phantom';
kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1') });
r = await call(good, { kv });
assert(r.status === 502 && r.data.code === 'guide_delete_unknown' && !/Nothing was deleted/.test(r.data.error) && read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3,
  'an unconfirmed Guide delete changes no page and never claims nothing was deleted');

// 8. Otra Guide 500 or no answer with the type still listed -> unknown (the
// request may still land), no page changed, the pending record is kept.
for (const mode of ['boom', 'timeout']) {
  resetGuide();
  guideDeleteMode = mode;
  kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1') });
  r = await call(good, { kv });
  assert(r.status === 502 && r.data.code === 'guide_delete_unknown' && !/Nothing was deleted/.test(r.data.error) && /Delete again/.test(r.data.error),
    `a Guide ${mode} is an unknown result (got ${r.status} ${JSON.stringify(r.data)})`);
  assert(read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3 && kv.store.has(`ticket-delete:${EVENT}:12`), `a Guide ${mode} changes no page and keeps the pending record`);
}
// 8a. A final Guide answer drops the pending record.
for (const mode of ['sold', 'missing', 'refused']) {
  resetGuide();
  guideDeleteMode = mode;
  kv = makeKv({});
  await call(good, { kv });
  assert(!kv.store.has(`ticket-delete:${EVENT}:12`), `a final Guide answer (${mode}) leaves no pending record`);
}

// 8b. Otra Guide drops the delete answer and then can't be re-read -> the result is unknown, no page changes.
for (const mode of ['boom', 'ok', 'sold']) {
  resetGuide();
  guideDeleteMode = mode;
  downAfterDelete = true;
  kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1'), [`event:${EVENT}`]: { fields: { [rateKey(3)]: { type: 'text', value: 'x' } } } });
  r = await call(good, { kv });
  assert(r.status === 502 && r.data.code === 'guide_delete_unknown' && !/Nothing was deleted/.test(r.data.error) && /Delete again/.test(r.data.error),
    `a failed re-read after Guide ${mode} never claims nothing was deleted (got ${r.status} ${JSON.stringify(r.data)})`);
  assert(read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3 && read(kv, `event:${EVENT}`).fields[rateKey(3)]?.value === 'x',
    `a failed re-read after Guide ${mode} changes no page`);
}

// 8c. A re-read that loses the other types (the details answer, the rate list
// fails, so the fallback shows no tickets) is not proof of a delete.
for (const mode of ['boom', 'missing', 'ok']) {
  resetGuide();
  guideDeleteMode = mode;
  partialAfterDelete = true;
  kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1'), [`event:${EVENT}`]: { fields: { [rateKey(3)]: { type: 'text', value: 'x' } } } });
  r = await call(good, { kv });
  assert(r.status === 502 && r.data.code === 'guide_delete_unknown', `a partial re-read after Guide ${mode} is unknown (got ${r.status} ${JSON.stringify(r.data)})`);
  assert(read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3 && read(kv, `event:${EVENT}`).fields[rateKey(3)]?.value === 'x',
    `a partial re-read after Guide ${mode} changes no page`);
}

// 8c2. A Guide failure, then only the public list answers and it hides the
// type (off sale now): that is not proof of a delete.
for (const mode of ['boom', 'timeout', 'missing']) {
  resetGuide();
  guideDeleteMode = mode;
  publicOnlyAfterDelete = true;
  kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1') });
  r = await call(good, { kv });
  assert(r.status === 502 && r.data.code === 'guide_delete_unknown' && read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3,
    `a type hidden from the public list after Guide ${mode} is not taken as deleted (got ${r.status} ${JSON.stringify(r.data)})`);
}

// 8d. A 500 that still deleted (seen gone on the full staff read) updates the pages.
resetGuide();
guideDeleteMode = 'lateboom';
kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1') });
r = await call(good, { kv });
assert(r.status === 200 && read(kv, 'site-event:draft-qa-1').ticketTypeIds.join(',') === '11,13', 'a Guide 500 that deleted anyway still updates the pages');

// 8e. A late delete: no answer, then Otra Guide finishes it. Pressing Delete
// again finishes the pages without a second Guide call.
resetGuide();
guideDeleteMode = 'timeout';
kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1'), [`event:${EVENT}`]: { fields: { [rateKey(3)]: { type: 'text', value: 'XCG 5000' } } } });
r = await call(good, { kv });
assert(r.status === 502 && r.data.code === 'guide_delete_unknown', 'no answer from Otra Guide is unknown');
guide = guide.filter((t) => t.id !== 12);
r = await call({ ...good, confirmName: 'wrong' }, { kv });
assert(r.status === 409 && kv.store.has(`ticket-delete:${EVENT}:12`), 'finishing an earlier delete still needs the exact name');
r = await call(good, { kv });
assert(r.status === 200 && r.data.finishedEarlierDelete === true && guideDeletes() === 1, `pressing Delete again finishes the pages (got ${r.status} ${JSON.stringify(r.data)})`);
assert(read(kv, 'site-event:draft-qa-1').ticketTypeIds.join(',') === '11,13' && read(kv, `event:${EVENT}`).fields[rateKey(2)]?.value === 'XCG 5000'
  && !kv.store.has(`ticket-delete:${EVENT}:12`), 'the finished delete updates pages once and clears the pending record');

// 8f. A page write fails after the Guide delete: clear message, and pressing
// Delete again finishes without moving any page twice.
for (const failAt of ['draft-page', 'progress-save', 'edit-marker']) {
  resetGuide();
  kv = makeKv({
    'site-event:draft-qa-1': boundProject('draft-qa-1'),
    [`event:${EVENT}`]: { fields: { [rateKey(3)]: { type: 'text', value: 'XCG 5000' } } },
    'event:draft-qa-1': { fields: { [rateKey(3, 1)]: { type: 'text', value: 'Table of 10' } } },
  });
  kv.failPut = failAt === 'draft-page'
    ? (key) => key === 'event:draft-qa-1'
    : failAt === 'edit-marker'
      // The page edit move is written, then its progress save fails.
      ? (key, value) => key.startsWith('ticket-delete:') && JSON.parse(value).done.includes(`edit:event:${EVENT}`)
      : (key, value) => key.startsWith('ticket-delete:') && JSON.parse(value).done.length === 1;
  r = await call(good, { kv });
  assert(r.status === 500 && r.data.code === 'pages_not_updated' && r.data.deletedOnGuide === true && !/Nothing was deleted/.test(r.data.error),
    `a failed page write after the Guide delete says it was deleted on Otra Guide (${failAt}, got ${r.status} ${JSON.stringify(r.data)})`);
  r = await call(good, { kv });
  assert(r.status === 200 && r.data.finishedEarlierDelete === true, `pressing Delete again finishes (${failAt})`);
  assert(read(kv, `event:${EVENT}`).fields[rateKey(2)]?.value === 'XCG 5000' && read(kv, 'event:draft-qa-1').fields[rateKey(2, 1)]?.value === 'Table of 10',
    `no page moves twice and none is missed (${failAt})`);
  assert(read(kv, 'site-event:draft-qa-1').ticketTypeIds.join(',') === '11,13' && !kv.store.has(`ticket-delete:${EVENT}:12`), `the retry clears the pending record (${failAt})`);
}

// 8f2. A second delete while one is still running is refused before Otra
// Guide; a finished request (or a lock left by a request that died) does not block.
resetGuide();
guideDeleteMode = 'boom';
kv = makeKv({ [`event:${EVENT}`]: { fields: { [rateKey(3)]: { type: 'text', value: 'XCG 5000' } } } });
r = await call(good, { kv });
assert(r.status === 502 && guideDeletes() === 1, 'first delete is unknown');
assert(read(kv, `ticket-delete:${EVENT}:12`).lockedUntil === null, 'an ended request releases its lock');
const held = read(kv, `ticket-delete:${EVENT}:12`);
kv.store.set(`ticket-delete:${EVENT}:12`, JSON.stringify({ ...held, lockedUntil: new Date(Date.now() + 60 * 1000).toISOString() }));
guideDeleteMode = 'ok';
r = await call(good, { kv });
assert(r.status === 409 && r.data.code === 'delete_in_progress' && guideDeletes() === 1, `a delete while one is running is refused (got ${r.status} ${JSON.stringify(r.data)})`);
kv.store.set(`ticket-delete:${EVENT}:12`, JSON.stringify({ ...held, lockedUntil: new Date(Date.now() - 1000).toISOString() }));
r = await call(good, { kv });
assert(r.status === 200 && guideDeletes() === 2 && read(kv, `event:${EVENT}`).fields[rateKey(2)]?.value === 'XCG 5000', `an expired lock does not block a new delete (got ${r.status} ${JSON.stringify(r.data)})`);

// 8f3. The finish path takes the same lock: a finish while another run is
// going is refused and changes no page.
resetGuide();
guideDeleteMode = 'timeout';
kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1'), [`event:${EVENT}`]: { fields: { [rateKey(3)]: { type: 'text', value: 'XCG 5000' } } } });
r = await call(good, { kv });
guide = guide.filter((t) => t.id !== 12);
const open = read(kv, `ticket-delete:${EVENT}:12`);
kv.store.set(`ticket-delete:${EVENT}:12`, JSON.stringify({ ...open, lockedUntil: new Date(Date.now() + 60 * 1000).toISOString() }));
r = await call(good, { kv });
assert(r.status === 409 && r.data.code === 'delete_in_progress' && read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3 && read(kv, `event:${EVENT}`).fields[rateKey(3)]?.value === 'XCG 5000',
  `a finish while another run holds the lock is refused (got ${r.status} ${JSON.stringify(r.data)})`);
// After a reload the type is gone from the checkout, so the admin lists the open delete to finish it.
const listedOpen = await listPendingDeletes(kv, EVENT, { tickets: guide });
assert(listedOpen.length === 1 && listedOpen[0].ticketTypeId === '12' && listedOpen[0].name === 'Table of 12' && listedOpen[0].running === true, 'an open delete is listed for Edit checkout');
assert((await listPendingDeletes(kv, EVENT, { tickets: [{ id: 12 }] })).length === 0, 'an open delete whose type is still listed is not offered as a finish');
kv.store.set(`ticket-delete:${EVENT}:12`, JSON.stringify({ ...open, lockedUntil: null }));
r = await call(good, { kv });
assert(r.status === 200 && r.data.finishedEarlierDelete === true && read(kv, `event:${EVENT}`).fields[rateKey(2)]?.value === 'XCG 5000', `the finish runs once the lock is free (got ${r.status} ${JSON.stringify(r.data)})`);
assert((await listPendingDeletes(kv, EVENT, { tickets: guide })).length === 0, 'a finished delete is no longer listed');

// 8f4. Two cleanups that overlap (each with its own progress) never move a
// page twice: the move is marked inside the page document itself.
kv = makeKv({ [`event:${EVENT}`]: { fields: { [rateKey(2)]: { type: 'text', value: 'b' }, [rateKey(3)]: { type: 'text', value: 'c' } }, updatedAt: '2026-01-01T00:00:00.000Z' } });
const shiftArgs = { eventId: EVENT, ticketTypeId: 12, guideRow: 2, draftRows: new Map() };
assert(await shiftRateOverrides(kv, shiftArgs) === 1 && await shiftRateOverrides(kv, shiftArgs) === 0, 'a second run of the same delete moves nothing');
const once = read(kv, `event:${EVENT}`);
assert(once.fields[rateKey(2)]?.value === 'c' && !(rateKey(3) in once.fields) && once.ticketDeletesApplied.includes(`${EVENT}:12`), 'the page moved exactly once and carries the marker');
assert(await shiftRateOverrides(kv, { ...shiftArgs, ticketTypeId: 11, guideRow: 1 }) === 1, 'a later delete of another type still moves the page');

// 8f5. A published bound draft keeps its version, so the live page merge
// never changes which document wins; its edits move by the Otra Guide row.
assert(nextVersion('2026-01-01T00:00:00.000Z') === '2026-01-01T00:00:00.001Z', 'a moved page gets the next millisecond');
assert(nextVersion('2026-01-01T00:00:00.000Z', new Set([Date.parse('2026-01-01T00:00:00.001Z')])) === '2026-01-01T00:00:00.000Z', 'the next millisecond never reaches a published draft version');
assert(nextVersion(undefined, new Set([1])) === undefined, 'a page without a version gets none while published drafts exist');
for (const [eventAt, draftAt] of [['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'], ['2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'], [undefined, '2026-02-01T00:00:00.000Z']]) {
  resetGuide();
  const pub = { ...boundProject('draft-pub'), ticketTypeIds: [11, 13, 12], status: 'published' };
  const pubOther = { ...boundProject('draft-pub-old'), ticketTypeIds: [11, 13], ticketQuantities: [130, 156], claudeDesign: { rates: [{}, {}] }, status: 'published' };
  const eventDoc = { fields: { [rateKey(2)]: { type: 'text', value: 'live 12' }, [rateKey(3)]: { type: 'text', value: 'live 13' } }, draftEditsFrom: 'draft-pub', pageEditsVersion: 2, ...(eventAt ? { updatedAt: eventAt } : {}) };
  const draftDoc = { fields: { [rateKey(3, 1)]: { type: 'text', value: 'draft 13' }, 'text:h1': { type: 'text', value: 'old draft title' } }, description: 'old draft text', updatedAt: draftAt };
  const oldDoc = { fields: { [rateKey(3, 1)]: { type: 'text', value: 'old 13' } }, updatedAt: draftAt };
  kv = makeKv({ 'site-event:draft-pub': pub, 'site-event:draft-pub-old': pubOther, [`event:${EVENT}`]: eventDoc, 'event:draft-pub': draftDoc, 'event:draft-pub-old': oldDoc });
  const winner = (ev, dr) => {
    if (coversDraft(ev, 'draft-pub', dr)) return 'live page as is';
    const m = mergeOverrideDocs(dr, ev);
    return `merged, description ${m.description}, row 2 ${m.fields[rateKey(2)]?.value}, updatedAt from ${m.updatedAt === dr.updatedAt ? 'draft' : 'live'}`;
  };
  const winnerBefore = winner(eventDoc, draftDoc);
  r = await call(good, { kv });
  assert(r.status === 200, `published draft case returns 200 (got ${r.status} ${JSON.stringify(r.data)})`);
  const eventAfter = read(kv, `event:${EVENT}`);
  const draftAfter = read(kv, 'event:draft-pub');
  assert(draftAfter.updatedAt === draftAt && read(kv, 'event:draft-pub-old').updatedAt === draftAt, `a published draft document keeps its version (${eventAt})`);
  assert(draftAfter.description === 'old draft text' && draftAfter.fields['text:h1']?.value === 'old draft title', 'a published draft keeps everything but the moved rows');
  assert(draftAfter.fields[rateKey(2, 1)]?.value === 'draft 13' && !(rateKey(3, 1) in draftAfter.fields), 'a published draft moves by the Otra Guide row');
  assert(read(kv, 'event:draft-pub-old').fields[rateKey(2, 1)]?.value === 'old 13', 'a published draft without the type still moves with the live page');
  const winnerAfter = winner(eventAfter, draftAfter).replace('row 2 live 13', 'row 2 live 12');
  assert(winnerBefore === winnerAfter, `the live page merge keeps the same winner (${eventAt}: ${winnerBefore} vs ${winnerAfter})`);
  const before = Date.parse(eventAt || '') || 0;
  const after = Date.parse(eventAfter.updatedAt || '') || 0;
  assert((before < Date.parse(draftAt)) === (after < Date.parse(draftAt)) && (before > Date.parse(draftAt)) === (after > Date.parse(draftAt)), `the live page version keeps its order against the draft (${eventAt})`);
  assert(eventAfter.fields[rateKey(2)]?.value === 'live 13', 'the live page moves by the Otra Guide row');
}

// 8g. A bound draft listing the type twice is refused before Otra Guide is called.
resetGuide();
kv = makeKv({ 'site-event:draft-dup': { ...boundProject('draft-dup'), ticketTypeIds: [12, 12, 13] } });
r = await call(good, { kv });
assert(r.status === 409 && r.data.code === 'draft_ambiguous' && /Nothing was deleted/.test(r.data.error) && guideDeletes() === 0, 'a draft listing the type twice is refused');

// 9. Success.
resetGuide();
kv = makeKv({
  'site-event:draft-qa-1': boundProject('draft-qa-1'),
  'site-event:draft-qa-old': boundProject('draft-qa-old'),
  'site-event:draft-other': { ...boundProject('draft-other'), otraGuideId: 7777 },
  [`event:${EVENT}`]: { fields: { [rateKey(2)]: { type: 'text', value: '6000' }, [rateKey(3)]: { type: 'text', value: 'XCG 5000' } }, updatedAt: '2026-01-01T00:00:00.000Z' },
  'event:draft-qa-1': { fields: { [rateKey(3, 1)]: { type: 'text', value: 'Table of 10' } } },
  'event:7777': { fields: { [rateKey(3)]: { type: 'text', value: 'keep' } } },
});
r = await call(good, { kv });
assert(r.status === 200, `success returns 200 (got ${r.status} ${JSON.stringify(r.data)})`);
assert(guideDeletes() === 1, 'Otra Guide DELETE called once');
assert(calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/ticket/create/tickets/${EVENT}/12/`)), 'the event-scoped staff route is used');
assert(r.data.deleted?.id === 12 && r.data.deleted?.name === 'Table of 12', 'response names what was deleted');
assert(r.data.event.tickets.map((t) => t.id).join(',') === '11,13', 'response carries the refreshed checkout');
assert(r.data.pagesUpdated === 2, 'both pages bound to the event are updated');
assert(read(kv, 'site-event:draft-qa-1').ticketTypeIds.join(',') === '11,13', 'bound draft ids spliced');
assert(read(kv, 'site-event:draft-qa-old').ticketQuantities.join(',') === '130,156', 'older bound copy spliced too');
assert(read(kv, 'site-event:draft-other').ticketTypeIds.length === 3, 'another event is untouched');
const live = read(kv, `event:${EVENT}`);
assert(live.fields[rateKey(2)]?.value === 'XCG 5000' && !(rateKey(3) in live.fields), 'live page edits move up a row');
assert(live.updatedAt !== '2026-01-01T00:00:00.000Z', 'moved edits bump the version so open editor tabs merge instead of overwriting');
assert(read(kv, 'event:draft-qa-1').fields[rateKey(2, 1)]?.value === 'Table of 10', 'draft page edits move up a row');
assert(read(kv, 'event:7777').fields[rateKey(3)]?.value === 'keep', 'another event page edits are untouched');
assert(!kv.store.has(`ticket-delete:${EVENT}:12`), 'a finished delete leaves no pending record');
const audit = [...kv.store.keys()].filter((k) => k.startsWith('audit:'));
assert(audit.length >= 1 && [...kv.store.entries()].some(([k, v]) => k.startsWith('audit:') && v.includes('ticket-type-deleted:12:Table of 12')), 'the delete is in the audit log');

// 10. Already gone after a lost response -> request is refused clearly, nothing else deleted.
r = await call(good, { kv });
assert(r.status === 409 && guideDeletes() === 1, 'repeating a finished delete is refused without calling Otra Guide');

// 11. Each page moves by its own rate row, never by another page's.
assert(draftRateRow({ ticketTypeIds: [13, 11, 12], claudeDesign: { rates: [{}, {}, {}] } }, 12) === 3, 'draft row comes from the draft own order');
assert(draftRateRow({ ticketTypeIds: [11, 12, 13], claudeDesign: { rates: [{}, {}] } }, 12) === 2, 'a draft row is the id index while that index has a rate');
assert(draftRateRow({ ticketTypeIds: [11, 12, 13], claudeDesign: { rates: [{}, {}] } }, 13) === 0, 'an id past the rates has no row');
assert(draftRateRow({ ticketTypeIds: [11, 12, 13] }, 12) === 0, 'a draft without rates never moves');
resetGuide();
kv = makeKv({
  'site-event:draft-reordered': { ...boundProject('draft-reordered'), ticketTypeIds: [13, 11, 12] },
  'site-event:draft-uneven': { ...boundProject('draft-uneven'), claudeDesign: { rates: [{ name: 'Only one' }] } },
  'site-event:draft-short-ids': { ...boundProject('draft-short-ids'), ticketTypeIds: [11, 12] },
  'event:draft-reordered': { fields: { [rateKey(2)]: { type: 'text', value: 'second' }, [rateKey(3)]: { type: 'text', value: 'deleted row' } } },
  'event:draft-uneven': { fields: { [rateKey(3)]: { type: 'text', value: 'uneven keep' } } },
  'event:draft-foreign': { checkoutEventId: String(EVENT), fields: { [rateKey(3)]: { type: 'text', value: 'foreign draft keep' } } },
  'event:8888': { checkoutEventId: String(EVENT), fields: { [rateKey(3)]: { type: 'text', value: 'sells through' } } },
  [`event:${EVENT}`]: { checkoutEventId: '9999', fields: { [rateKey(3)]: { type: 'text', value: 'points elsewhere' } } },
});
r = await call(good, { kv });
assert(r.status === 200, `reordered success returns 200 (got ${r.status} ${JSON.stringify(r.data)})`);
const reordered = read(kv, 'event:draft-reordered').fields;
assert(reordered[rateKey(2)]?.value === 'second' && !(rateKey(3) in reordered), 'a reordered draft drops its own row 3, not the Guide row 2');
assert(read(kv, 'site-event:draft-reordered').ticketTypeIds.join(',') === '13,11', 'reordered draft ids spliced');
assert(read(kv, 'site-event:draft-uneven').ticketTypeIds.join(',') === '11,13', 'uneven draft ids still spliced');
assert(read(kv, 'event:draft-uneven').fields[rateKey(3)]?.value === 'uneven keep', 'a draft with no rate for the type keeps its page edits');
assert(read(kv, 'site-event:draft-uneven').claudeDesign.rates.length === 1, 'a draft with no rate for the type keeps its rates');
const shortIds = read(kv, 'site-event:draft-short-ids');
assert(shortIds.ticketTypeIds.join(',') === '11' && shortIds.claudeDesign.rates.map((x) => x.name).join('|') === 'Single ticket|Table of 10' && shortIds.ticketQuantities.join(',') === '130,156',
  'a draft with fewer ids than rates keeps each id paired with its rate (a publish pairs by index)');
assert(read(kv, 'event:draft-foreign').fields[rateKey(3)]?.value === 'foreign draft keep', 'a draft not bound to the event keeps its page edits');
assert(read(kv, 'event:8888').fields[rateKey(2)]?.value === 'sells through', 'an event page that sells through this event moves by the Guide row');
assert(read(kv, `event:${EVENT}`).fields[rateKey(3)]?.value === 'points elsewhere', 'an event page that sells another event keeps its page edits');
assert(await shiftRateOverrides(kv, { eventId: EVENT, guideRow: 0, draftRows: new Map() }) === 0, 'nothing moves without a known row');


// 12. Counts and ids are read strictly: a value that only looks numeric never
// fakes a 0 sold count and never turns into another id.
for (const bad of [true, false, [], [5], '1e2', '12.5', ' ', 'abc', {}, NaN, Infinity, -3, 1.5]) {
  assert(optionalCount(bad) === null, `optionalCount(${JSON.stringify(bad)}) is unknown`);
}
assert(optionalCount(' 7 ') === 7 && optionalCount(156) === 156, 'plain counts still read');
assert(listedSoldCount({ quantity: true, remaining_quantity: true }) === null && listedSoldCount({ quantity: 156, remaining_quantity: [] }) === null,
  'boolean or array counts never read as 0 sold');
for (const bad of ['12abc', '12.5', '1e1', true, [12], 0, -12, 12.5, '', null, '7567 ']) {
  if (bad === '7567 ') continue;
  assert(strictId(bad) === null, `strictId(${JSON.stringify(bad)}) is refused`);
}
assert(strictId('12') === 12 && strictId(12) === 12, 'exact ids still read');
for (const bad of [{ ticketTypeId: '12abc' }, { ticketTypeId: '12.5' }, { ticketTypeId: true }, { eventId: `${EVENT}x` }, { eventId: '1e6' }]) {
  resetGuide();
  r = await call({ ...good, ...bad });
  assert(r.status === 400 && guideDeletes() === 0 && /Nothing was deleted/.test(r.data.error), `a loose id is refused before Otra Guide (${JSON.stringify(bad)})`);
}
resetGuide();
r = await call({ ...good, ticketTypeId: '12' });
assert(r.status === 200 && guideDeletes() === 1, `a digits-only string id still works (got ${r.status} ${JSON.stringify(r.data)})`);

// 13. No page storage -> refused before Otra Guide.
resetGuide();
r = await call(good, { noKv: true });
assert(r.status === 503 && guideDeletes() === 0 && /Nothing was deleted/.test(r.data.error), 'without page storage nothing is sent to Otra Guide');

// 14. Only the public fallback answers before the delete -> refused (it hides types off sale).
resetGuide();
staffSearchDown = true;
r = await call(good);
assert(r.status === 503 && r.data.code === 'guide_read_incomplete' && guideDeletes() === 0, `a partial checkout read never sends a delete (got ${r.status} ${JSON.stringify(r.data)})`);

// 15. Lock race: another request writes its own lock right after ours -> this
// request backs off before Otra Guide and before any page write.
resetGuide();
kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1') });
{
  const realPut = kv.put.bind(kv);
  kv.put = async (key, value) => {
    await realPut(key, value);
    if (key.startsWith('ticket-delete:')) {
      const rec = JSON.parse(value);
      await realPut(key, JSON.stringify({ ...rec, lockToken: 'someone-else' }));
    }
  };
}
r = await call(good, { kv });
assert(r.status === 409 && r.data.code === 'delete_in_progress' && guideDeletes() === 0 && read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3,
  `a lost lock race never calls Otra Guide (got ${r.status} ${JSON.stringify(r.data)})`);
assert(read(kv, `ticket-delete:${EVENT}:12`).lockToken === 'someone-else', 'the loser never frees or drops the winner lock');
// releaseLock with a stale token leaves the record alone; claimLock reads back.
kv = makeKv({ k: { lockToken: 'a', lockedUntil: new Date(Date.now() + 60000).toISOString() } });
await releaseLock(kv, 'k', 'b');
await releaseLock(kv, 'k', 'b', true);
assert(read(kv, 'k').lockToken === 'a' && read(kv, 'k').lockedUntil, 'a stale token never frees or drops a lock');
const won = await claimLock(kv, 'k2', { x: 1 });
assert(won && won.lockToken && read(kv, 'k2').lockToken === won.lockToken, 'claimLock returns the record it wrote');

// 16. A Guide 405 (no delete route) frees the record and changes nothing,
// and the next attempt is not blocked by a stuck lock.
resetGuide();
guideDeleteMode = 'missing';
kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1') });
r = await call(good, { kv });
r = await call(good, { kv });
assert(r.status === 501 && guideDeletes() === 2 && !kv.store.has(`ticket-delete:${EVENT}:12`), 'a 405 never leaves a lock behind');
// A thrown fetch or a 500 keeps the record but frees the lock.
for (const mode of ['timeout', 'boom']) {
  resetGuide();
  guideDeleteMode = mode;
  kv = makeKv({});
  await call(good, { kv });
  const rec = read(kv, `ticket-delete:${EVENT}:12`);
  assert(rec.lockedUntil === null, `a Guide ${mode} frees the lock`);
}

// 17. The live rate rows change order between the delete and the finish:
// pages still drop the type, but live page edits are left alone (never moved by a stale row).
assert(liveRowsStillMatch({ ticketTypeId: '12', rateIds: ['11', '12', '13'] }, [{ id: 11 }, { id: 13 }]), 'same order without the deleted type matches');
assert(liveRowsStillMatch({ ticketTypeId: '12', rateIds: ['11', '12', '13'] }, [{ id: 11 }, { id: 12 }, { id: 13 }]), 'a cached list that still shows the deleted type matches');
assert(!liveRowsStillMatch({ ticketTypeId: '12', rateIds: ['11', '12', '13'] }, [{ id: 13 }, { id: 11 }]), 'a reordered list does not match');
assert(!liveRowsStillMatch({ ticketTypeId: '12', rateIds: ['11', '12', '13'] }, [{ id: 11 }]), 'a shorter list does not match');
assert(!liveRowsStillMatch({ ticketTypeId: '12' }, [{ id: 11 }]), 'an old record without the order does not match');
resetGuide();
guideDeleteMode = 'timeout';
kv = makeKv({
  'site-event:draft-qa-1': boundProject('draft-qa-1'),
  [`event:${EVENT}`]: { fields: { [rateKey(3)]: { type: 'text', value: 'live 13' } } },
  'event:draft-qa-1': { fields: { [rateKey(3, 1)]: { type: 'text', value: 'draft 13' } } },
});
r = await call(good, { kv });
guide = [guide[2], guide[0]];
r = await call(good, { kv });
assert(r.status === 200 && r.data.finishedEarlierDelete === true && r.data.liveEditsNotMoved === true, `a reordered live list finishes with a warning (got ${r.status} ${JSON.stringify(r.data)})`);
assert(read(kv, `event:${EVENT}`).fields[rateKey(3)]?.value === 'live 13', 'live page edits are not moved by a stale row');
assert(read(kv, 'site-event:draft-qa-1').ticketTypeIds.join(',') === '11,13' && read(kv, 'event:draft-qa-1').fields[rateKey(2, 1)]?.value === 'draft 13',
  'the draft still drops the type and moves by its own row');

// 18. The rate list can't be read at finish time -> nothing is changed, the
// lock is freed, and Delete again finishes once the list answers.
resetGuide();
guideDeleteMode = 'timeout';
kv = makeKv({ 'site-event:draft-qa-1': boundProject('draft-qa-1'), [`event:${EVENT}`]: { fields: { [rateKey(3)]: { type: 'text', value: 'x' } } } });
await call(good, { kv });
guide = guide.filter((t) => t.id !== 12);
rateDown = true;
r = await call(good, { kv });
assert(r.status === 500 && r.data.code === 'pages_not_updated' && read(kv, 'site-event:draft-qa-1').ticketTypeIds.length === 3
  && read(kv, `event:${EVENT}`).fields[rateKey(3)]?.value === 'x' && read(kv, `ticket-delete:${EVENT}:12`).lockedUntil === null,
  `an unreadable rate list changes no page and frees the lock (got ${r.status} ${JSON.stringify(r.data)})`);
rateDown = false;
r = await call(good, { kv });
assert(r.status === 200 && read(kv, `event:${EVENT}`).fields[rateKey(2)]?.value === 'x' && !r.data.liveEditsNotMoved, 'Delete again finishes once the list answers');

// 19. A draft reordered between the delete and the finish moves by the row it
// has now, not the row it had when the delete started.
resetGuide();
guideDeleteMode = 'timeout';
kv = makeKv({
  'site-event:draft-qa-1': boundProject('draft-qa-1'),
  'event:draft-qa-1': { fields: { [rateKey(1, 1)]: { type: 'text', value: 'row1' }, [rateKey(2, 1)]: { type: 'text', value: 'row2' }, [rateKey(3, 1)]: { type: 'text', value: 'row3' } } },
});
await call(good, { kv });
const edited = boundProject('draft-qa-1');
edited.ticketTypeIds = [12, 11, 13];
edited.claudeDesign.rates = [{ name: 'Table of 12' }, { name: 'Single ticket' }, { name: 'Table of 10' }];
kv.store.set('site-event:draft-qa-1', JSON.stringify(edited));
guide = guide.filter((t) => t.id !== 12);
r = await call(good, { kv });
const movedDraft = read(kv, 'event:draft-qa-1').fields;
assert(r.status === 200 && movedDraft[rateKey(1, 1)]?.value === 'row2' && movedDraft[rateKey(2, 1)]?.value === 'row3' && !(rateKey(3, 1) in movedDraft),
  `a reordered draft moves by its current row (got ${JSON.stringify(movedDraft)})`);

// 20. Finishing never touches another event's open delete.
resetGuide();
kv = makeKv({ [`ticket-delete:7777:12`]: { eventId: '7777', ticketTypeId: '12', name: 'Table of 12', otherIds: ['11'] } });
guide = guide.filter((t) => t.id !== 12);
r = await call(good, { kv });
assert(r.status === 409 && kv.store.has('ticket-delete:7777:12') && guideDeletes() === 0, 'another event open delete is never finished from this event');
assert((await listPendingDeletes(kv, EVENT, { tickets: guide })).length === 0, 'another event open delete is not listed here');

// Admin UI wiring.
assert(/data-checkout-delete="\$\{esc\(ticket\.id\)\}"/.test(adminHtml), 'each saved ticket row has a Delete button');
assert(/function openTicketDelete/.test(adminHtml) && /Otra Guide ID<\/dt>/.test(adminHtml) && /<dt>Sold<\/dt>/.test(adminHtml), 'step 1 shows name, price, id and sold');
assert(/already has \$\{sold\} sold ticket/.test(adminHtml), 'the UI blocks a sold type with the count');
assert(/data-checkout-delete-confirm disabled/.test(adminHtml) && /confirm\.disabled = input\.value\.trim\(\) !== String\(ticket\.name\)\.trim\(\)/.test(adminHtml), 'final button stays off until the exact name is typed');
assert(/method: "DELETE"[\s\S]{0,200}ticketTypeId/.test(adminHtml), 'the UI calls DELETE /admin/api/events');
assert(/function deleteCheckoutTicket[\s\S]*renderCheckoutTickets\(checkoutEvent\.tickets[\s\S]*refreshPreview\(\)/.test(adminHtml), 'success re-renders rows and refreshes the page and embed');
assert(/data-checkout-delete-impact>[^<]*Otra Guide app and website checkout[^<]*Otra Tickets checkout/.test(adminHtml), 'step 1 states the Otra Guide and Otra Tickets impact');
assert(/\/Nothing was deleted\|Reload\|Delete again\|Finish page update\|Wait a minute\/\.test\(err\.message\)\s*\?\s*err\.message\s*:\s*`\$\{err\.message \|\| "No answer from Otra Tickets\."\} Close and reopen Edit checkout/.test(adminHtml) && !/`\$\{err\.message\} Nothing was deleted\.`/.test(adminHtml), 'only server refusals say nothing was deleted; an unknown result asks for a reload');
assert(/if \(data\.pageEditsMoved \|\| data\.finishedEarlierDelete\) await reloadOverrideAfterDelete\(\)/.test(adminHtml), 'after moved page edits (or a finished earlier delete) the editor loads the page as stored now');
assert(/checkoutPendingDeletes = Array\.isArray\(data\.pendingDeletes\)/.test(adminHtml) && /data-finish-delete=/.test(adminHtml) && /function finishPendingDelete[\s\S]{0,1500}method: "DELETE"[\s\S]{0,300}confirmName: item\.name/.test(adminHtml),
  'Edit checkout offers Finish page update for an open delete after a reload');
assert(/function checkoutHasUnsavedEdits/.test(adminHtml), 'unsaved edits block a delete instead of being thrown away');
assert(/pageRows === event\.tickets\.length\) ticket = event\.tickets\[rowIndex\]/.test(adminHtml), 'price pencil only falls back to row position when the page and checkout rows line up');

assert(/failed\.deletedOnGuide && failed\.event[\s\S]{0,400}renderPendingDeletes\(\)/.test(adminHtml), 'a delete whose page update failed shows Finish page update right away');
assert(/data\.liveEditsNotMoved \?/.test(adminHtml), 'the UI says when live page edits were not moved');

if (failures.length) {
  console.error(`FAIL check-admin-ticket-type-delete (${failures.length})`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PASS check-admin-ticket-type-delete');
