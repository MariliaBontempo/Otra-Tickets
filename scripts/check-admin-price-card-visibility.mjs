// Oracle: price cards can be hidden from the Otra Tickets presentation without
// mutating checkout data, and an explicit admin control can restore them.
// Run: node scripts/check-admin-price-card-visibility.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';
import { onRequestPut } from '../functions/admin/api/overrides.js';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const overridesApi = fs.readFileSync(new URL('../functions/admin/api/overrides.js', import.meta.url), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

function extractFunction(name) {
  const functionIndex = html.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (functionIndex < 0) return '';
  const asyncIndex = html.lastIndexOf('async ', functionIndex);
  const start = asyncIndex >= 0 && /^async\s+$/.test(html.slice(asyncIndex, functionIndex))
    ? asyncIndex
    : functionIndex;
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  return '';
}

const candidateSource = extractFunction('candidateSections');
const removeSource = extractFunction('removeSection');
const hiddenKeysSource = extractFunction('hiddenPriceCardKeys');
const restoreSource = extractFunction('restoreHiddenPriceCards');
const selectorSource = extractFunction('selectorFor');

assert(candidateSource.includes('main.querySelectorAll(".ev-rate")'), 'the editor must discover individual rate cards');
assert(candidateSource.includes('"price-card"'), 'rate-card removal candidates must be identified as presentation price cards');
assert(removeSource.includes('persistOverrideFields'), 'hiding a card must preserve checkout id, accent, and the rest of the override');
assert(removeSource.includes('ticket type and checkout stay unchanged'), 'the confirmation must explain that checkout is unaffected');
assert(!removeSource.includes('/admin/api/events'), 'hiding a card must never mutate the Otra Guide event or ticket types');
assert(restoreSource.includes('delete fields[key]'), 'restoring must delete only the stored remove override');
assert(/id="restorePriceCardsBtn"/.test(html), 'the admin must expose a restore control for hidden price cards');
assert(/data-otra-rate-name=/.test(fs.readFileSync(new URL('../event.html', import.meta.url), 'utf8')), 'rendered rate cards must expose a stable name key');
assert(selectorSource.includes('data-otra-rate-name'), 'price-card selectors must use the stable rate name instead of card position');
assert(
  /field\.kind === "price-card"[\s\S]*fields\[key\]\.kind = "price-card"/.test(overridesApi),
  'the admin API must preserve price-card metadata so the restore control survives a save and reload'
);

{
  const rate = { name: 'Community / Sponsor' };
  const section = { name: 'Entrance contribution' };
  const main = {
    querySelectorAll(selector) {
      if (selector === ':scope > section, :scope > footer') return [section];
      if (selector === '.ev-rate') return [rate];
      return [];
    },
  };
  const sandbox = {
    currentOverride: { fields: {} },
    isRemovableSection: () => true,
    selectorFor: (element) => element === rate ? '#evRates > .ev-rate[data-otra-rate-name="Community / Sponsor"]' : '#evRatesSection',
  };
  vm.runInNewContext(`${candidateSource}; this.run = candidateSections;`, sandbox);
  const fields = sandbox.run({ body: main, querySelector: (selector) => selector === 'main' ? main : null });
  const priceCard = fields.find((field) => field.element === rate);
  assert(priceCard?.kind === 'price-card', 'an .ev-rate element must become a price-card removal candidate');
  assert(
    priceCard?.key === 'remove:#evRates > .ev-rate[data-otra-rate-name="Community / Sponsor"]',
    'the price-card override must target the named outer card'
  );
}

{
  const sandbox = {
    currentOverride: {
      fields: {
        'remove:#evRates > .ev-rate[data-otra-rate-name="Community / Sponsor"]': { type: 'remove', kind: 'price-card' },
        'remove:#story': { type: 'remove', kind: 'section' },
        'text:#evTitle': { type: 'text', value: 'Kaya Kaya' },
      },
    },
  };
  vm.runInNewContext(`${hiddenKeysSource}; this.run = hiddenPriceCardKeys;`, sandbox);
  const keys = sandbox.run();
  assert(keys.length === 1 && keys[0].includes('#evRates'), 'restore discovery must include only hidden price cards');
}

{
  let savedFields = { 'text:#evTitle': { type: 'text', value: 'Kaya Kaya' } };
  let refreshed = false;
  const sandbox = {
    selected: { id: 'draft-kaya' },
    window: { confirm: () => true },
    sectionLabel: () => 'Community / Sponsor',
    setStatus: () => {},
    refreshPreview: () => { refreshed = true; },
    persistOverrideFields: async (mutate) => {
      const next = structuredClone(savedFields);
      mutate(next);
      savedFields = next;
    },
  };
  vm.runInNewContext(`${removeSource}; this.run = removeSection;`, sandbox);
  await sandbox.run({
    key: 'remove:#evRates > .ev-rate[data-otra-rate-name="Community / Sponsor"]',
    kind: 'price-card',
    element: {},
  });
  const stored = savedFields['remove:#evRates > .ev-rate[data-otra-rate-name="Community / Sponsor"]'];
  assert(stored?.type === 'remove' && stored?.kind === 'price-card', 'hiding must store a presentation-only remove field');
  assert(savedFields['text:#evTitle']?.value === 'Kaya Kaya', 'hiding must preserve unrelated override fields');
  assert(refreshed, 'the preview must refresh after hiding a card');
}

{
  const store = new Map();
  const kv = {
    async get(key) { return store.get(key) || null; },
    async put(key, value) { store.set(key, value); },
    async list() { return { keys: [], list_complete: true }; },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/users/user-role/')) {
      return { ok: true, json: async () => ({ is_staff_or_admin: true }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const response = await onRequestPut({
      request: new Request('https://otratickets.com/admin/api/overrides?id=7567', {
        method: 'PUT',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        body: JSON.stringify({
          checkoutEventId: '7567',
          accentColor: '#9f7aea',
          fields: {
            'remove:#evRates > .ev-rate[data-otra-rate-name="Community / Sponsor"]': {
              type: 'remove',
              value: '1',
              kind: 'price-card',
              label: 'Community / Sponsor',
            },
          },
        }),
      }),
      env: { OVERRIDES: kv, OTRA_API_URL: 'https://og.test/api' },
    });
    const body = await response.json();
    const field = body.override?.fields?.['remove:#evRates > .ev-rate[data-otra-rate-name="Community / Sponsor"]'];
    assert(response.status === 200, 'the admin API must accept a presentation-only price-card removal');
    assert(field?.kind === 'price-card', 'the API response must preserve the price-card kind for restoration');
    assert(field?.label === 'Community / Sponsor', 'the API response must preserve the hidden card label');
    assert(body.override?.checkoutEventId === '7567', 'saving the removal must preserve the checkout event id');
    assert(body.override?.accentColor === '#9f7aea', 'saving the removal must preserve the accent color');
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (failures.length) {
  console.error(`check-admin-price-card-visibility: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('check-admin-price-card-visibility: all assertions passed');
