// Run with the companion curacao-calendar checkout next to this repository.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const backend = new URL('../../curacao-calendar/', import.meta.url);
// Compare against the point the feature branch forked from main, so the check proves the
// branch itself changes no payment code and stays valid as main moves.
const baseline = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: backend, encoding: 'utf8' }).trim();
const read = file => readFileSync(new URL(file, backend), 'utf8').replaceAll('\r\n', '\n');
const original = file => execFileSync('git', ['show', `${baseline}:${file}`], { cwd: backend, encoding: 'utf8' }).replaceAll('\r\n', '\n');
for (const file of ['apps/ticketing/views.py', 'apps/ticketing/views_stripe_checkout.py',
  'apps/ticketing/purchasing.py', 'apps/ticketing/sentoo_gateway.py']) {
  assert.equal(read(file), original(file), `${file}: payment code must remain unchanged`);
}
// Only the optional notification lines may differ from the merge base; strip them from both
// sides so requests, validation and redirects are compared verbatim.
const notifyCalls = /^.*try \{ window\.otraNotifyCheckout\?\.\((true|false)\); \} catch \(_\) \{\}\n/gm;
const strips = {
  'templates/ticketing/stripe_checkout_iframe_otratickets.html': text => text
    .replace(/^.*include "ticketing\/components\/meta_checkout.html".*\n/gm, '').replace(notifyCalls, ''),
  'templates/ticketing/stripe_checkout_iframe_simple.html': text => text
    .replace(/^.*include ["'](?:ticketing\/components\/meta_checkout|web\/components\/facebook_pixel).html["'].*\n/gm, '')
    .replace(notifyCalls, ''),
  'templates/ticketing/ticket_purchase.html': text => text
    .replace(/^.*include "ticketing\/components\/meta_checkout.html".*\n/gm, '')
    .replace(/  \/\/ Optional Meta observer:[\s\S]*?  \/\/ End optional Meta observer\.\n/, ''),
};
for (const [name, strip] of Object.entries(strips)) {
  assert.equal(strip(read(name)), strip(original(name)),
    `${name}: only optional notifications may differ; requests, validation and redirects must match`);
}
const template = read('templates/ticketing/stripe_checkout_iframe_otratickets.html');
// Render the one template tag the helper carries, as Django would with the default EUR cushion.
const helper = read('templates/ticketing/components/meta_checkout.html').replace(/<\/?script>/g, '')
  .replace('{{ eur_fx_markup_multiplier|default:1|stringformat:"f" }}', '1.030000');
assert(!/\{\{|\{%/.test(helper), 'every template tag must be rendered before the helper runs');
assert(!/fetch\(|setTimeout\(|location\s*=|location\.href\s*=|preventDefault/.test(helper));
// Base-currency list data and rates as the checkout pages expose them.
const originals = { ticketDataOriginal: { 1: { price: 20, baseCurrency: 'USD', hasFee: true, feePercentage: 10 } },
  addonsDataOriginal: { 2: { price: 5, baseCurrency: 'USD', hasFee: false } }, currencyData: { USD: { rate: 1 } } };
for (const bank of [true, false]) {
  const messages = [];
  const window = { ...originals, parent: { postMessage: (message, origin) => messages.push({ message, origin }) } };
  const context = vm.createContext({ window, tickets: { 1: { qty: 2, price: 20, hasFee: true, feeAmount: 2 } },
    addons: { 2: { qty: 1, price: 5, hasFee: false } }, currentCurrency: 'USD',
    crypto: { randomUUID: () => 'attempt-1' }, location: { hostname: 'otraguide.com' }, URL });
  vm.runInContext(helper, context);
  window.otraNotifyCheckout(bank); window.otraNotifyCheckout(bank);
  assert.equal(messages.length, 4, 'one notification per allowlisted origin, no repeat');
  assert.equal(messages[0].message.data.value, bank ? 44 : 49);
  assert.equal(messages[0].message.data.currency, bank ? 'XCG' : 'USD');
  assert.equal(messages[0].message.data.contents[0].quantity, 2);
  assert.equal(messages[0].message.data.contents[0].item_price, 22);
}
const calls = [];
const direct = { OTRAMeta: { initiateCheckout: data => calls.push(data) },
  ticketDataOriginal: { 1: { price: 25, baseCurrency: 'USD', hasFee: false } }, currencyData: { USD: { rate: 1 } } };
direct.parent = direct;
const directContext = vm.createContext({ window: direct, crypto: { randomUUID: () => 'direct-attempt' } });
vm.runInContext(helper, directContext);
direct.otraNotifyCheckout(false, { 1: { qty: 2, price: 25 } }, {}, 'USD');
direct.otraNotifyCheckout(false, { 1: { qty: 2, price: 25 } }, {}, 'USD');
assert.equal(calls.length, 1);
assert.equal(calls[0].value, 50);
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
