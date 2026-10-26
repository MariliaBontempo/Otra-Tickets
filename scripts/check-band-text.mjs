// Oracle: the appreciation band ("What We Appreciate", "Details") must let
// an editor add wording on any draft, not only on drafts whose design
// already had a heading. Body text has its own block under the heading that
// keeps the casing it was typed in (the heading stays the bold caps h2), and
// a band with only a heading or text reads from the top.
// Run: node scripts/check-band-text.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const overrides = fs.readFileSync(new URL('../site-overrides.js', import.meta.url), 'utf8');
const eventHtml = fs.readFileSync(new URL('../event.html', import.meta.url), 'utf8');
const validator = fs.readFileSync(new URL('../functions/admin/api/_draft-content.js', import.meta.url), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

function extractFunction(name, source = html) {
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
const extractConst = (name, source = html) => (source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[[\\s\\S]*?\\];`)) || [''])[0];
const cssRule = (selectorPart) => {
  const index = eventHtml.indexOf(selectorPart);
  if (index < 0) return '';
  return eventHtml.slice(index, eventHtml.indexOf('}', index) + 1);
};

// 1) Public template: a text block under the band heading.
assert(/<h2 id="evBandTitle"[^>]*><\/h2>\s*<div class="ev-band-text" id="evBandText" hidden><\/div>/.test(eventHtml), 'event.html must have a hidden #evBandText right under #evBandTitle');
const textRule = cssRule('.ev-band-text {');
assert(/text-transform:\s*none/.test(textRule), 'band text must keep its typed casing');
assert(/white-space:\s*pre-line/.test(textRule), 'band text must keep its line breaks');
assert(/font-weight:\s*400/.test(textRule), 'band text must not be bold like the heading');
assert(/\.ev-band:has\(#evBandText:not\(\[hidden\]\)\)[^{]*\{[^}]*aspect-ratio:\s*auto/.test(eventHtml), 'a band with text must grow instead of clipping in the 16:9 box');
assert(/\.ev-band:has\(#evBandText:not\(\[hidden\]\)\)\s*\{[^}]*align-items:\s*flex-start/.test(eventHtml), 'a band with section text must read from the top');
assert(!/\.ev-band:not\(:has\(\.ev-like\)\)/.test(eventHtml), 'a band without section text must keep its centered heading (no change on published pages)');
assert(/\.ev-band \{[^}]*align-items: center/.test(eventHtml), 'bands with perk items keep the centred layout');
assert(eventHtml.includes('design.bandImage || design.bandTitle || design.bandText ||'), 'band text alone must show the band');
assert(eventHtml.includes('$("evBandText").textContent = design.bandText || "";') && eventHtml.includes('$("evBandText").hidden = !design.bandText;'), 'band text must render as text and hide when empty');

// 2) Draft content editor: Section text field round trips.
assert(/textLimits = \{[^}]*bandText: 8000/.test(validator), 'the server must accept bandText up to 8000 characters');
assert(/<textarea id="draftContentBandText" rows="\d+" maxlength="8000"><\/textarea>/.test(html), 'draft content modal must have a Section text textarea');
assert(html.includes('$("draftContentBandText").value = design.bandText || "";'), 'Section text must load the saved band text');
assert(/bandText: \{ input: "draftContentBandText"/.test(html) && html.includes('...draftContentPencilValues(),'), 'Section text must be saved');
const label = (html.match(/<label>(Section text[^<]*)<textarea id="draftContentBandText"/) || [])[1] || '';
assert(label && !/[-\u2010-\u2015]/.test(label), 'Section text label must exist and have no hyphen or dash');

// 3) Editor: empty heading and text get a pencil on every draft.
const slotsSource = extractConst('EMPTY_TEXT_SLOTS');
const revealSource = extractFunction('revealEmptyTextSlots');
const editableSource = extractFunction('isEditableText');
const injectSource = extractFunction('injectEditControls');
assert(slotsSource.includes('"#evBandTitle"') && slotsSource.includes('"#evBandText"'), 'EMPTY_TEXT_SLOTS must cover the band heading and text');
for (const m of slotsSource.matchAll(/label: "([^"]*)"/g)) assert(!/[-\u2010-\u2015]/.test(m[1]), `empty text label "${m[1]}" must have no hyphen or dash`);
assert(injectSource.indexOf('revealEmptyTextSlots(doc)') > -1 && injectSource.indexOf('revealEmptyTextSlots(doc)') < injectSource.indexOf('const fields = candidateElements(doc)'), 'injectEditControls must mark empty text slots before collecting pencils');
assert(html.includes('".ev-band-text"'), 'band text must be in the editable text selector');
assert(/\[hidden\]\[data-otra-empty-text\][^{]*\{\s*display: block !important/.test(html), 'editor CSS must show a hidden empty band text box');
assert(/\[data-otra-empty-text\]::before \{\s*content: attr\(data-otra-empty-text\)/.test(html), 'editor CSS must show the empty text hint');

class El {
  constructor(id, text = '', parent = null) { this.id = id; this.textContent = text; this.attrs = {}; this.hidden = false; this.parentElement = parent; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return n in this.attrs; }
  closest(sel) {
    const ids = sel.split(',').map((s) => s.trim());
    let node = this;
    while (node) {
      if (ids.some((s) => (s.startsWith('#') && s.slice(1) === node.id) || s === 'section')) return node;
      node = node.parentElement;
    }
    return null;
  }
}
const ctx = { fieldOverrideForKey: () => null };
vm.createContext(ctx);
vm.runInContext(`${slotsSource}\n${revealSource}\n${editableSource}\n${extractFunction('revealBandText', overrides)}\nthis.api = { revealEmptyTextSlots, isEditableText, revealBandText };`, ctx);
const { revealEmptyTextSlots, isEditableText, revealBandText } = ctx.api;
const makeDoc = (title = '', text = '') => {
  const band = new El('evBandSection'); band.hidden = true;
  const h2 = new El('evBandTitle', title, band);
  const body = new El('evBandText', text, band); body.hidden = !text;
  const all = [band, h2, body];
  return { band, h2, body, doc: { querySelector: (s) => all.find((e) => '#' + e.id === s) || null } };
};
// Monkeypatch closest for isEditableText (looks for admin controls/header).
const noAncestors = (el) => { const real = el.closest.bind(el); el.closest = (sel) => (/header|data-otra-admin-edit/.test(sel) ? null : real(sel)); };

// Nov 28 style: band with no wording at all.
{
  const d = makeDoc();
  [d.h2, d.body].forEach(noAncestors);
  assert(!isEditableText(d.h2, 'text:#evBandTitle'), 'precondition: empty heading has no pencil before marking');
  const marked = revealEmptyTextSlots(d.doc);
  assert(marked.length === 2, `both empty band text slots must be marked, got ${marked.length}`);
  assert(isEditableText(d.h2, 'text:#evBandTitle'), 'empty band heading must get a pencil');
  assert(isEditableText(d.body, 'text:#evBandText'), 'empty band text must get a pencil');
  assert(d.body.hidden && d.band.hidden, 'the editor must not flip hidden, CSS shows the slot');
  revealEmptyTextSlots(d.doc);
  assert(d.h2.hasAttribute('data-otra-empty-text'), 'marking must be idempotent');
}
// Nov 26 style: heading already typed.
{
  const d = makeDoc('Want to do more?');
  [d.h2, d.body].forEach(noAncestors);
  revealEmptyTextSlots(d.doc);
  assert(!d.h2.hasAttribute('data-otra-empty-text'), 'a heading with text is not a placeholder');
  assert(isEditableText(d.h2, 'text:#evBandTitle'), 'a heading with text keeps its pencil');
  assert(d.body.hasAttribute('data-otra-empty-text'), 'empty band text still gets a placeholder under a typed heading');
  d.body.textContent = 'Access: all areas';
  revealEmptyTextSlots(d.doc);
  assert(!d.body.hasAttribute('data-otra-empty-text'), 'placeholder clears once text exists');
}
// Public page: saved band wording shows the band.
{
  const d = makeDoc();
  revealBandText(d.body, 'Details\nAccess: all areas');
  assert(!d.body.hidden && !d.band.hidden, 'saved band text must show the text block and the band');
  const e = makeDoc();
  revealBandText(e.h2, '   ');
  assert(e.band.hidden, 'blank saved wording must not show an empty band');
  const sponsor = new El('evSponsorText', '', e.band); sponsor.hidden = true;
  revealBandText(sponsor, 'Thanks');
  assert(sponsor.hidden && e.band.hidden, 'only the band heading and text reveal the band');
}
assert(/revealBandText\(el, value\);/.test(extractFunction('applyFieldOverrides', overrides)), 'text overrides must call revealBandText');

if (failures.length) {
  console.error('FAIL check-band-text');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('PASS check-band-text');
