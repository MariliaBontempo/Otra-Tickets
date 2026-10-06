import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../../functions/admin/api/projects.js';

const id = 'draft-1791253678425-26c548a5';
const oldInfo = [
  { key: 'Venue', value: 'BRGR HAUS – Caracasbaai' },
  { key: 'Date', value: 'To confirm' },
  { key: 'Time', value: 'To confirm' },
  { key: 'Admission', value: 'Finish Line Ticket — welcome drink and appetizer; sale terms pending' },
  { key: 'Status', value: 'Draft prototype — pending approval' },
  { key: 'Pricing', value: 'Prototype values retained as reference; currency and sale terms to confirm' },
];
const project = () => ({
  id, status: 'published', adminOnly: false, publishedAt: '2026-10-06T16:12:49Z',
  otraGuideId: '8088', otraGuideSlug: '8088', usesExistingOtraGuideEvent: true,
  title: 'Mike Gatta 50/50/50', ticketTypeIds: [491], ticketQuantities: [200],
  claudeDesign: { practicalInfo: oldInfo, rates: [{ name: 'Finish Line Ticket', price: '20.00', currency: 'USD' }] },
  untouched: { preserve: true },
});

async function run({ token = 'staff', targetId = id, mutate = () => {}, bodyChange = () => {} } = {}) {
  const records = new Map([[`site-event:${id}`, structuredClone(project())], ['site-event:draft-other', { id: 'draft-other', status: 'published' }]]);
  const writes = [];
  const kv = {
    async get(key) { return structuredClone(records.get(key) ?? null); },
    async put(key, value) { writes.push(key); records.set(key, JSON.parse(value)); },
    async list() { return { keys: [{ name: `site-event:${id}` }], list_complete: true }; },
  };
  const env = { OVERRIDES: kv, OTRA_API_URL: 'https://guide.test' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === '/users/user-role/') return Response.json({ is_staff_or_admin: new Headers(options.headers).get('authorization') === 'Bearer staff' });
    if (path === '/users/profile/') return Response.json({ first_name: 'Local', last_name: 'Test' });
    throw new Error(`Unexpected request ${path}`);
  };
  try {
    const opened = await onRequestGet({ env, request: new Request('https://site.test/admin/api/projects', { headers: { authorization: `Bearer ${token}` } }) });
    const expectedProject = opened.ok ? (await opened.json()).projects[0] : null;
    mutate(records.get(`site-event:${id}`));
    const body = { expectedProject };
    bodyChange(body);
    const request = new Request(`https://site.test/admin/api/projects?action=finalize-practical-8088&id=${targetId}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const response = await onRequestPost({ env, request });
    return { status: response.status, body: await response.json(), records, writes };
  } finally { globalThis.fetch = originalFetch; }
}

test('finalizes only event 8088 practical copy and preserves commercial and unrelated data', async () => {
  const result = await run();
  assert.equal(result.status, 200);
  const saved = result.records.get(`site-event:${id}`);
  assert.deepEqual(saved.claudeDesign.practicalInfo, [
    { key: 'Venue', value: 'BRGR HAUS – Caracasbaai' },
    { key: 'Date', value: 'Date to confirm' },
    { key: 'Time', value: 'Time to confirm' },
    { key: 'Admission', value: 'Finish Line Ticket — $20 · Welcome Drink by Annabay Rum · Appetizer by BRGR HAUS' },
  ]);
  assert.deepEqual(saved.ticketTypeIds, [491]);
  assert.deepEqual(saved.ticketQuantities, [200]);
  assert.deepEqual(saved.claudeDesign.rates, project().claudeDesign.rates);
  assert.deepEqual(saved.untouched, { preserve: true });
  assert.deepEqual(result.records.get('site-event:draft-other'), { id: 'draft-other', status: 'published' });
  assert.equal(result.writes.filter(key => key.startsWith('site-event:')).length, 1);
});

test('rejects other project ids, unpublished pages, stale snapshots and changed copy', async () => {
  for (const options of [
    { targetId: 'draft-other' },
    { mutate: p => { p.status = 'draft'; } },
    { mutate: p => { p.ticketTypeIds = [999]; } },
    { mutate: p => { p.claudeDesign.practicalInfo[0].value = 'Changed venue'; } },
    { bodyChange: b => { b.expectedProject = {}; } },
  ]) {
    const result = await run(options);
    assert.ok([400, 409].includes(result.status));
    assert.equal(result.writes.filter(key => key.startsWith('site-event:')).length, 0);
  }
});

test('rejects non-staff callers', async () => {
  const result = await run({ token: 'visitor' });
  assert.equal(result.status, 401);
  assert.deepEqual(result.writes, []);
});
