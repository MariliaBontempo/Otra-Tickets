// Exercise the real handlers with in-memory KV and a mocked Guide API.
// No external HTTP calls, browser profile, or production writes are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { onRequestPost } from '../functions/admin/api/projects.js';
import { onRequestPut } from '../functions/admin/api/events.js';
import { onRequestGet as readEvent } from '../functions/api/event.js';

const ZIP_BASE64 = 'UEsDBBQAAAAAAAezRV0/9G5ReQAAAHkAAAAKAAAAaW5kZXguaHRtbDxzZWN0aW9uIGNsYXNzPSJldi10aXRsZWJsb2NrIj48aDE+WklQIGxheW91dCBmaXh0dXJlPC9oMT48L3NlY3Rpb24+PHNlY3Rpb24gaWQ9InN0b3J5Ij48cD5GaXh0dXJlIGNvbnRlbnQuPC9wPjwvc2VjdGlvbj5QSwECFAMUAAAAAAAHs0VdP/RuUXkAAAB5AAAACgAAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLBQYAAAAAAQABADgAAAChAAAAAAA=';
const originalFetch = globalThis.fetch;
const previewOutput = process.argv.indexOf('--preview-output');
let previewFixture;
let checked = 0;

function memoryKV() {
  const values = new Map();
  return {
    values,
    async get(key, type) {
      const value = values.get(key);
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, value); },
    async list() { return { keys: [...values.keys()].map(name => ({ name })), list_complete: true }; },
    async delete(key) { values.delete(key); },
  };
}

try {
  for (const [inputCurrency, expectedCurrency, fallback] of [
    ['XCG', 'XCG', false], ['USD', 'USD', false], ['EUR', 'EUR', false],
    ['ANG', 'ANG', false], ['xcg', 'XCG', false],
    ['XCG', 'XCG', true], ['USD', 'USD', true], ['EUR', 'EUR', true],
    ['ANG', 'ANG', true], ['', 'USD', true],
  ]) {
    const kv = memoryKV();
    const env = { OVERRIDES: kv, OTRA_API_URL: 'https://backend.test/api' };
    const calls = [];
    const guideTicket = { id: 491, name: 'Entrance', price: '35.00', quantity: 200,
      description: '', currency: inputCurrency, isActive: true };
    const detail = { id: 8088, slug: '505050-fundraiser', title: '50/50/50 Fundraiser',
      description: 'Local contract fixture.', published: true, staff_only: true,
      start_date: '2026-10-12T22:00:00Z', end_date: '2026-10-13T03:00:00Z',
      team: { id: 1, name: 'Otra Guide', region: 1 }, location: 'Local fixture venue' };
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://backend.test', 'all Guide calls must be mocked');
      const call = { path: url.pathname + url.search, method: options.method || 'GET' };
      if (options.body && typeof options.body === 'string') call.body = JSON.parse(options.body);
      calls.push(call);
      if (call.path === '/api/users/user-role/') return Response.json({ is_staff_or_admin: true });
      if (call.path === '/api/events/details/8088/') return Response.json(detail);
      if (call.path === '/api/events/admin-ticketed-search/?id=8088') {
        return fallback ? new Response('{}', { status: 404 }) : Response.json({
          events: [{ ...detail, startDate: detail.start_date, endDate: detail.end_date,
            tickets: [guideTicket] }],
        });
      }
      if (call.path === '/api/ticket/purchase/tickets/8088/') return Response.json({
        results: [{ ...guideTicket, base_currency: { code: inputCurrency } }],
      });
      if (call.path === '/api/ticket/create/tickets/8088/491/' && call.method === 'PATCH') {
        return Response.json({ id: 491 });
      }
      if (call.path === '/api/events/create/' && call.method === 'POST') {
        return Response.json({ id: 9090, slug: 'local-fixture-copy' });
      }
      if (call.path === '/api/ticket/create/tickets/9090/' && call.method === 'POST') {
        return Response.json({ id: 999 });
      }
      throw new Error(`Unexpected mock call: ${call.method} ${call.path}`);
    };
    const form = new FormData();
    form.set('file', new File([Buffer.from(ZIP_BASE64, 'base64')], 'fixture.zip', { type: 'application/zip' }));
    form.set('existingEventId', '8088');
    form.set('regionId', '1');
    form.set('adminOnly', 'true');
    const response = await onRequestPost({ env, request: new Request('https://tickets.test/admin/api/projects', {
      method: 'POST', headers: { authorization: 'Bearer local-fixture' }, body: form,
    }) });
    assert.equal(response.status, 201, 'existing-event binding must succeed');
    const { project } = await response.json();
    assert.equal(project.otraGuideId, '8088');
    assert.deepEqual(project.ticketTypeIds, [491]);
    assert.deepEqual(project.ticketQuantities, [200]);
    assert.equal(project.status, 'draft');
    assert.equal(project.usesExistingOtraGuideEvent, true);
    assert.equal(project.claudeDesign.rates[0].currency, expectedCurrency,
      `${inputCurrency || '(missing)'} must retain its currency during binding`);
    assert.equal(project.claudeDesign.rates[0].price, '35.00', 'price must not be converted');
    assert(calls.every(c => c.method === 'GET'), 'binding must never write Guide events or tickets');
    assert.equal(detail.published, true, 'existing publication must not change');
    const eventResponse = await readEvent({ env, request: new Request(
      `https://tickets.test/api/event?id=${project.id}`, { headers: { authorization: 'Bearer local-fixture' } }
    ) });
    assert.equal(eventResponse.status, 200);
    const eventPayload = await eventResponse.json();
    assert.equal(eventPayload.checkoutEventId, '8088');
    assert.equal(eventPayload.tickets[0].currency, expectedCurrency);
    assert.equal(eventPayload.tickets[0].price, '35.00');
    assert.equal(eventPayload.isDraft, true);
    if (inputCurrency === 'XCG' && !fallback) {
      previewFixture = { project, eventPayload, guideTicket };
    }
    if (!inputCurrency) {
      calls.length = 0;
      const invalidResponse = await onRequestPut({ env, request: new Request('https://tickets.test/admin/api/events', {
        method: 'PUT', headers: { authorization: 'Bearer local-fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: 8088, tickets: [{ ...guideTicket, currency: 'GBP' }] }),
      }) });
      assert.equal(invalidResponse.status, 400, 'unsupported currencies must still be rejected');
      assert(calls.every(c => c.method === 'GET'), 'invalid input must never write a ticket');
    }
    if (['XCG', 'USD', 'EUR', 'ANG'].includes(inputCurrency) && !fallback) {
      calls.length = 0;
      const editResponse = await onRequestPut({ env, request: new Request('https://tickets.test/admin/api/events', {
        method: 'PUT', headers: { authorization: 'Bearer local-fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: 8088, tickets: [guideTicket] }),
      }) });
      assert.equal(editResponse.status, 200, `${inputCurrency} checkout edits must be accepted`);
      const write = calls.find(c => c.method === 'PATCH');
      assert.equal(write.path, '/api/ticket/create/tickets/8088/491/');
      assert.deepEqual(write.body, { name: 'Entrance', description: '', price: '35.00', quantity: 200,
        base_currency: expectedCurrency });
      calls.length = 0;
      const copyResponse = await onRequestPost({ env, request: new Request(
        `https://tickets.test/admin/api/projects?action=clone&id=${project.id}`, {
          method: 'POST', headers: { authorization: 'Bearer local-fixture', 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Local contract copy' }),
        }) });
      assert.equal(copyResponse.status, 201, 'copying the draft must succeed with mocked Guide writes');
      const copyTicket = calls.find(c => c.path === '/api/ticket/create/tickets/9090/');
      assert.equal(copyTicket.body.base_currency, expectedCurrency, 'copy must preserve ticket currency');
      assert.equal(copyTicket.body.price, '35.00');
      assert.equal(copyTicket.body.quantity, 200);
    }
    checked++;
  }
  const adminHtml = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
  const render = adminHtml.match(/function renderCheckoutTickets\(tickets\) \{[\s\S]*?\n  \}/)?.[0];
  assert(render, 'checkout renderer must exist');
  const container = { innerHTML: '' };
  vm.runInNewContext(`${render}; renderCheckoutTickets(tickets);`, {
    $: () => container, esc: value => String(value ?? ''),
    tickets: [{ id: 491, name: 'Entrance', price: '35.00', quantity: 200, currency: 'XCG' }],
  });
  assert.match(container.innerHTML, /value="XCG" selected/, 'editor must keep XCG selected');
  if (previewOutput >= 0) fs.writeFileSync(process.argv[previewOutput + 1], JSON.stringify(previewFixture, null, 2) + '\n');
  console.log(`check-xcg-draft-currency OK (${checked} bindings, real handlers; XCG/USD/EUR/ANG edits and copies; editor selection)`);
} finally {
  globalThis.fetch = originalFetch;
}
