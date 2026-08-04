// Oracle: the Edit dropdown must add dates to same-title events while leaving
// unique event labels unchanged. The pages API must provide those dates for
// both Otra Tickets drafts and published Otra Guide events.
// Run: node scripts/check-admin-duplicate-event-dates.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';
import { onRequestGet } from '../functions/admin/api/pages.js';

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

function extractFunction(name, source) {
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

const adminHtml = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const helperNames = ['formatShortDate', 'pageTitleKey', 'countPageTitles', 'pageOptionLabel'];
const helperSource = helperNames.map((name) => extractFunction(name, adminHtml)).join('\n');
helperNames.forEach((name) => assert(helperSource.includes(`function ${name}`), `${name} must exist`));

const sandbox = {};
vm.runInNewContext(`${helperSource}; this.count = countPageTitles; this.label = pageOptionLabel;`, sandbox);

const options = [
  { id: '7514', title: 'Sunday Social Club', type: 'Published draft', startDate: '2026-09-06T12:00:00-04:00' },
  { id: '7516', title: ' sunday social club ', type: 'Published draft', startDate: '2026-09-20T12:00:00-04:00' },
  { id: '8000', title: 'Clear Boat West Coast', type: 'Published tour', startDate: '2026-10-01T09:00:00-04:00' },
];
const counts = sandbox.count(options);
const labels = options.map((page) => sandbox.label(page, counts));

assert(/Sunday Social Club.*Sep.*6.*2026.*Published draft/i.test(labels[0]), 'first duplicate must include its date');
assert(/sunday social club.*Sep.*20.*2026.*Published draft/i.test(labels[1]), 'second duplicate must include its date');
assert(labels[0] !== labels[1], 'same-title options must become distinguishable');
assert(labels[2] === 'Clear Boat West Coast - Published tour', 'a unique event must keep the original label');

const projects = new Map([
  ['site-event:draft-sep-6', {
    title: 'Bingo Bengo',
    status: 'draft',
    startDate: '2026-09-06T17:00:00-04:00',
  }],
  ['site-event:draft-dec-13', {
    title: 'Bingo Bengo',
    status: 'draft',
    startDate: '2026-12-13T17:00:00-04:00',
  }],
]);
const kv = {
  async list() {
    return { keys: [...projects.keys()].map((name) => ({ name })), list_complete: true };
  },
  async get(key) {
    if (key === 'admin:hidden-pages') return null;
    return projects.get(key) || null;
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/users/user-role/')) return Response.json({ is_staff_or_admin: true });
  if (url.includes('/events/nonperennial/')) {
    return Response.json({
      results: url.includes('page=1') ? [{
        id: 9001,
        title: 'Published Same Name',
        start_date: '2026-11-01T18:00:00-04:00',
        is_ticketed: true,
        is_perennial: false,
      }, {
        id: 9002,
        title: 'Published Same Name',
        start_date: '2026-11-08T18:00:00-04:00',
        is_ticketed: true,
        is_perennial: false,
      }] : [],
    });
  }
  if (url.includes('/ticket/purchase/tickets/')) return Response.json({ count: 1 });
  return new Response('{}', { status: 404 });
};

try {
  const response = await onRequestGet({
    request: new Request('https://tickets.test/admin/api/pages', {
      headers: { authorization: 'Bearer test-token' },
    }),
    env: { OTRA_API_URL: 'https://backend.test/api', OVERRIDES: kv },
  });
  const payload = await response.json();
  assert(response.status === 200, 'pages API must succeed');
  assert(payload.pages.find((page) => page.id === 'draft-sep-6')?.startDate === '2026-09-06T17:00:00-04:00', 'draft startDate must reach the dropdown');
  assert(payload.pages.find((page) => page.id === 'draft-dec-13')?.startDate === '2026-12-13T17:00:00-04:00', 'second draft startDate must reach the dropdown');
  assert(payload.pages.find((page) => page.id === '9001')?.startDate === '2026-11-01T18:00:00-04:00', 'published event startDate must reach the dropdown');
  assert(payload.pages.find((page) => page.id === '9002')?.startDate === '2026-11-08T18:00:00-04:00', 'second published event startDate must reach the dropdown');
} finally {
  globalThis.fetch = originalFetch;
}

if (failures.length) {
  console.error('check-admin-duplicate-event-dates FAILED:');
  failures.forEach((failure) => console.error(' - ' + failure));
  process.exit(1);
}

console.log('check-admin-duplicate-event-dates OK (duplicates dated, unique labels unchanged)');
