// Run with the companion curacao-calendar checkout next to this repository.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const backend = new URL('../../curacao-calendar/', import.meta.url);
// Pin the pre-feature revision so this check remains valid after committing the feature.
const baseline = '4a74f94c7cbb53ac8a8499aa42ba442ae011f66e';
const read = file => readFileSync(new URL(file, backend), 'utf8').replaceAll('\r\n', '\n');
const original = file => execFileSync('git', ['show', `${baseline}:${file}`], { cwd: backend, encoding: 'utf8' }).replaceAll('\r\n', '\n');
for (const file of ['apps/ticketing/views.py', 'apps/ticketing/views_stripe_checkout.py',
  'apps/ticketing/purchasing.py', 'apps/ticketing/sentoo_gateway.py']) {
  assert.equal(read(file), original(file), `${file}: payment code must remain unchanged`);
}
const file = 'templates/ticketing/stripe_checkout_iframe_otratickets.html';
const template = read(file);
assert.equal(template.replace(/^.*include "ticketing\/components\/meta_checkout.html".*\n/gm, '')
  .replace(/^.*try \{ window\.otraNotifyCheckout\?\.\((true|false)\); \} catch \(_\) \{\}\n/gm, ''), original(file),
  'Only optional notifications may differ; requests, validation and redirects must match the original');
const helper = read('templates/ticketing/components/meta_checkout.html').replace(/<\/?script>/g, '');
assert(!/fetch\(|setTimeout\(|location\s*=|location\.href\s*=|preventDefault/.test(helper));
for (const bank of [true, false]) {
  const messages = [];
  const window = { parent: { postMessage: (message, origin) => messages.push({ message, origin }) } };
  const context = vm.createContext({ window, tickets: { 1: { qty: 2, price: 20, hasFee: true, feeAmount: 2 } },
    addons: { 2: { qty: 1, price: 5, hasFee: false } }, currentCurrency: 'USD',
    crypto: { randomUUID: () => 'attempt-1' }, location: { hostname: 'otraguide.com' }, URL });
  vm.runInContext(helper, context);
  window.otraNotifyCheckout(bank); window.otraNotifyCheckout(bank);
  assert.equal(messages.length, 2, 'one notification per allowlisted origin, no repeat');
  assert.equal(messages[0].message.data.value, bank ? 44 : 49);
  assert.equal(messages[0].message.data.currency, bank ? 'XCG' : 'USD');
  assert.equal(messages[0].message.data.contents[0].quantity, 2);
  assert.equal(messages[0].message.data.contents[0].item_price, 22);
}
// Execute the exact added call with throwing/missing tracker: the next payment statement still runs.
for (const tracker of [undefined, () => { throw Error('blocked'); }]) {
  for (const bank of [true, false]) {
    const context = vm.createContext({ window: { otraNotifyCheckout: tracker }, proceeded: false });
    const call = template.split('\n').find(line => line.includes(`otraNotifyCheckout?.(${bank})`));
    vm.runInContext(call + '\nproceeded = true;', context);
    assert.equal(context.proceeded, true);
  }
}
console.log('Payment boundary checks passed: original provider code, validation, requests, submissions and redirects unchanged; notification failures isolated.');
