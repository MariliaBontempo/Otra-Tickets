// Oracle: the red X on a page section in the admin editor removes only that
// section and can always be undone.
//   1) site-overrides.js hides a removed section (data-otra-removed + hidden)
//      and keeps it in the DOM. event.html renders into sections by id, so a
//      section taken out of the DOM before the render made the render throw
//      and every section after it (prices, checkout) vanished.
//   2) The editor never offers a section X on a section holding prices,
//      checkout or Before You Go (checked against the real event.html markup).
//   3) removeSection asks first, and removed sections have a Restore control.
// Run: node scripts/check-admin-remove-section.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const overrides = fs.readFileSync(new URL('../site-overrides.js', import.meta.url), 'utf8');
const eventHtml = fs.readFileSync(new URL('../event.html', import.meta.url), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

function extractFunction(name, source) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

// ---- 1) site-overrides.js keeps removed sections in the DOM ----
{
  const apply = extractFunction('applyFieldOverrides', overrides);
  assert(/type === "remove" && field\.type === "remove"\)\s*\{\s*applyRemoval\(el\);/.test(apply), 'remove fields must go through applyRemoval');
  assert(!/type === "remove"[\s\S]{0,80}el\.remove\(\)/.test(apply), 'remove fields must not call el.remove() directly');

  const removed = [];
  const styles = [];
  const byId = new Map();
  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (el) => { styles.push(el); byId.set(el.id, el); } },
  };
  const makeEl = (tagName, id = '') => {
    const attrs = {};
    const el = {
      tagName, id, hidden: false,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      remove: () => { removed.push(el); if (id) byId.delete(id); },
    };
    if (id) byId.set(id, el);
    return el;
  };
  const ctx = { document };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('ensureRemovedStyle', overrides) + '\n' + extractFunction('applyRemoval', overrides), ctx);

  const rates = makeEl('SECTION', 'evRatesSection');
  const hero = makeEl('SECTION');
  const footer = makeEl('FOOTER');
  const card = makeEl('DIV');
  [rates, hero, footer, card].forEach((el) => ctx.applyRemoval(el));
  ctx.applyRemoval(rates); // applied again after a render: still one element, still hidden

  assert(!removed.includes(rates) && !removed.includes(hero) && !removed.includes(footer), 'a removed section must stay in the DOM');
  assert(document.getElementById('evRatesSection') === rates, 'event.html must still find #evRatesSection after it was removed (render must not throw)');
  for (const el of [rates, hero, footer]) {
    assert(el.hidden === true && el.getAttribute('data-otra-removed') === '1', `removed ${el.tagName}${el.id ? '#' + el.id : ''} must be hidden and marked`);
  }
  assert(removed.includes(card), 'a small item like a price card is still removed outright');
  assert(styles.length === 1, 'the hide rule is injected once, got ' + styles.length);
  const rule = styles[0] ? styles[0].textContent : '';
  assert(/\[data-otra-removed\]\[data-otra-removed\]\[data-otra-removed\]\s*\{\s*display:\s*none\s*!important/.test(rule), 'removed sections must stay hidden even when the render unhides them');
}

// ---- 2) the editor never offers a section X on prices / checkout / Before You Go ----
{
  const protectedConst = (html.match(/const PROTECTED_SECTION_CONTENT = "[^"]*";/) || [''])[0];
  assert(protectedConst, 'admin must define PROTECTED_SECTION_CONTENT');
  const isProtected = extractFunction('isProtectedSection', html);
  const isRemovable = extractFunction('isRemovableSection', html);
  assert(isRemovable.includes('isProtectedSection(el)'), 'isRemovableSection must refuse protected sections');

  // Build light elements from the real event.html sections: each knows the
  // ids and classes it contains, which is all the selectors need.
  const main = eventHtml.slice(eventHtml.indexOf('<main'), eventHtml.indexOf('</main>'));
  const sections = [...main.matchAll(/<(section|footer)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => {
    const attrs = m[2];
    const body = m[3];
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1] || '';
    const cls = ((attrs.match(/\bclass="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    const innerIds = [...body.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
    const innerCls = [...body.matchAll(/\bclass="([^"]+)"/g)].flatMap((x) => x[1].split(/\s+/));
    const hasAttr = (name) => new RegExp(`\\b${name}\\b`).test(attrs);
    const test = (sel, ids, classes) => sel.split(',').map((s) => s.trim()).some((s) =>
      s.startsWith('#') ? ids.includes(s.slice(1)) : s.startsWith('.') ? classes.includes(s.slice(1)) : false);
    return {
      tagName: m[1].toUpperCase(), id,
      label: id || cls[0] || m[1],
      closest: () => null,
      hasAttribute: (name) => name === 'hidden' ? false : hasAttr(name),
      hidden: false,
      matches: (sel) => test(sel, id ? [id] : [], cls),
      querySelector: (sel) => (test(sel, innerIds, innerCls) ? {} : null),
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
      ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } },
    };
  });
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${protectedConst}\n${isProtected}\n${isRemovable}`, ctx);
  const byLabel = Object.fromEntries(sections.map((s) => [s.label, s]));
  for (const id of ['evInfoSection', 'evRatesSection', 'book', 'evTicketsSkeleton']) {
    assert(byLabel[id], `event.html should still have #${id}`);
    if (byLabel[id]) assert(ctx.isRemovableSection(byLabel[id]) === false, `#${id} must not get a section X`);
  }
  for (const id of ['story', 'evVideoSection', 'evBandSection', 'evPhotoBandSection']) {
    if (byLabel[id]) assert(ctx.isRemovableSection(byLabel[id]) === true, `#${id} should keep its section X`);
  }
  // Any section that holds prices or checkout, whatever its id.
  for (const s of sections) {
    const holdsMoney = s.querySelector('#evRates, .ev-rates, #otra-checkout-container, #evInfoGrid');
    if (holdsMoney) assert(ctx.isRemovableSection(s) === false, `section ${s.label} holds prices/checkout/info and must not be removable`);
  }
  const marked = { ...sections[0], hasAttribute: (n) => n === 'data-otra-removed' };
  assert(ctx.isRemovableSection(marked) === false, 'an already removed section must not get another X');
}

// ---- 3) confirm + restore ----
{
  const remove = extractFunction('removeSection', html);
  assert(/window\.confirm\(`Remove this \$\{noun\}/.test(remove), 'removeSection must ask "Remove this section?" first');
  assert(remove.indexOf('isProtectedSection(field.element)') > -1 && remove.indexOf('isProtectedSection(field.element)') < remove.indexOf('persistOverrideFields'), 'removeSection must refuse a protected section before saving');
  assert(/<button class="btn ghost hidden" id="restoreSectionsBtn" type="button">/.test(html), 'admin must have a Restore removed sections button');
  const keys = extractFunction('removedSectionKeys', html);
  const ctx = { currentOverride: { fields: {
    'remove:#story': { type: 'remove', value: '1' },
    'remove:main > section:nth-of-type(2)': { type: 'remove', value: '1' },
    'remove:#evRates > .ev-rate[data-otra-rate-name="VIP"]': { type: 'remove', kind: 'price-card' },
    'text:#evTitle': { type: 'text', value: 'x' },
  } } };
  vm.createContext(ctx);
  vm.runInContext(keys, ctx);
  const got = ctx.removedSectionKeys();
  assert(got.length === 2 && got.includes('remove:#story') && got.includes('remove:main > section:nth-of-type(2)'), 'Restore removed sections must list section removals only, got ' + JSON.stringify(got));
  assert(/removedSectionKeys\(\)[\s\S]{0,400}delete fields\[key\]/.test(extractFunction('restoreRemovedSections', html)), 'restore must delete the remove fields');
  assert(/updateRemovedSectionControl\(\);/.test(extractFunction('fillForm', html)), 'the restore button must refresh whenever the override loads or saves');
}

if (failures.length) {
  console.error('check-admin-remove-section FAILED:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('check-admin-remove-section OK (sections hidden not deleted, protected sections have no X, confirm + restore)');
