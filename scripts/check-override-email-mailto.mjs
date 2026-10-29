// Oracle: plain organizer emails in page text become mailto links
// ("Enquiries: a@b.com" -> link), without changing the text, without parsing
// it as HTML, keeping line breaks, and without nesting links on a re-run.
// Run: node scripts/check-override-email-mailto.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';

const SOURCE = fs.readFileSync(new URL('../site-overrides.js', import.meta.url), 'utf8');
const failures = [];
const assert = (cond, msg) => { if (!cond) failures.push(msg); };

function extractFunction(name) {
  const start = SOURCE.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = SOURCE.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    if (SOURCE[i] === '}') { depth -= 1; if (depth === 0) return SOURCE.slice(start, i + 1); }
  }
  return '';
}

// Minimal DOM: element and text nodes with childNodes, textContent, insertBefore.
class Text {
  constructor(v) { this.nodeType = 3; this.nodeValue = v; this.parentNode = null; }
  get textContent() { return this.nodeValue; }
}
class Elem {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.childNodes = []; this.attrs = {}; this.parentNode = null; this.classList = { contains: (c) => (this.className || '').split(' ').includes(c) }; this.href = ''; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = []; if (v) this.appendChild(new Text(String(v))); }
  set innerHTML(_) { throw new Error('innerHTML must not be used'); }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) { n.parentNode = this; const i = this.childNodes.indexOf(ref); this.childNodes.splice(i, 0, n); return n; }
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  links() { const out = []; const w = (e) => e.childNodes.forEach((c) => { if (c.nodeType === 1) { if (c.tagName === 'A') out.push(c); w(c); } }); w(this); return out; }
}
const document = {
  createElement: (t) => new Elem(t),
  createTextNode: (v) => new Text(v),
  querySelectorAll: () => [],
};
const ctx = { document, Array, String };
vm.createContext(ctx);
for (const name of ['isAdminControl', 'linkifyEmails']) {
  const src = extractFunction(name);
  assert(src, `site-overrides.js must define ${name}`);
  vm.runInContext(src, ctx);
}
const linkify = ctx.linkifyEmails;
const el = (text) => { const e = new Elem('div'); e.textContent = text; return e; };

// 1) The Strange Bird line.
{
  const text = 'Enquiries: forexampleican@gmail.com';
  const e = el(text);
  linkify(e);
  const links = e.links();
  assert(links.length === 1, 'one email gives one link');
  assert(links[0] && links[0].href === 'mailto:forexampleican@gmail.com', 'link opens a mail to the email');
  assert(links[0] && links[0].textContent === 'forexampleican@gmail.com', 'link shows the email');
  assert(links[0] && links[0].attrs['data-otra-mailto'] === '1', 'link is marked as added by the page');
  assert(e.textContent === text, 'text stays the same');
}
// 2) Several emails, mid sentence, trailing punctuation, line breaks.
{
  const text = 'Arrival: 6:45pm.\n\nWrite to a.b+c@x.co.uk or (info@strange-bird.cw).\nThanks, team@ot.com.';
  const e = el(text);
  linkify(e);
  const hrefs = e.links().map((a) => a.href);
  assert(JSON.stringify(hrefs) === JSON.stringify(['mailto:a.b+c@x.co.uk', 'mailto:info@strange-bird.cw', 'mailto:team@ot.com']), `three emails become links without trailing punctuation (got ${hrefs})`);
  assert(e.textContent === text, 'text with line breaks stays byte identical');
  assert(e.childNodes.some((n) => n.nodeType === 3 && n.nodeValue.includes('\n\n')), 'line breaks stay in text nodes for pre-line');
  // 3) Idempotent.
  linkify(e);
  linkify(e);
  assert(e.links().length === 3, 'running again adds no links');
  assert(e.links().every((a) => a.links().length === 0), 'no nested links');
  assert(e.textContent === text, 'text unchanged after re-runs');
}
// 4) Text that is already a link is left alone.
{
  const e = new Elem('div');
  const a = e.appendChild(new Elem('a'));
  a.href = 'mailto:x@y.com';
  a.textContent = 'x@y.com';
  linkify(e);
  assert(e.links().length === 1 && e.childNodes.length === 1, 'existing link untouched');
}
// 4b) An edited button link never gets a link inside it.
{
  const btn = new Elem('a');
  btn.closest = (sel) => (sel.split(',').map((x) => x.trim()).includes('a') ? btn : null);
  btn.textContent = 'Mail info@ot.com';
  linkify(btn);
  assert(btn.childNodes.length === 1 && btn.childNodes[0].nodeType === 3, 'no link inside a link or button');
}
// 5) No email: DOM untouched.
{
  const e = el('Free as a bird. No email here @ all');
  const before = e.childNodes[0];
  linkify(e);
  assert(e.childNodes.length === 1 && e.childNodes[0] === before, 'text without an email is untouched');
  const empty = el('');
  linkify(empty);
  assert(empty.childNodes.length === 0, 'empty text stays empty');
}
// 6) HTML in the text is never parsed.
{
  const text = '<img src=x onerror=alert(1)> evil"@x.com <b>hi</b>';
  const e = el(text);
  linkify(e); // Elem.innerHTML throws if used
  assert(e.textContent === text, 'markup stays text');
  assert(e.links().every((a) => /^mailto:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(a.href)), 'href only has email characters');
  assert(!e.childNodes.some((n) => n.nodeType === 1 && n.tagName !== 'A'), 'no element other than a link is created');
}
// 7) Wiring: every text path calls the helper; price amounts never do.
assert(/if \(priceAmount\) fitPriceAmount\(el\);/.test(SOURCE), 'price amounts still use fitPriceAmount');
assert(/el\.id === "evBandText"/.test(SOURCE) && /linkifyEmails\(el\)/.test(SOURCE), 'text edits linkify band/story/info only after the compare, not every text field');
assert(!/else linkifyEmails\(el\);\s*\n\s*revealBandText/.test(SOURCE), 'generic text path must not linkify every field');
assert(/if \(subtitle\) linkifyEmails\(subtitle\);/.test(SOURCE), 'info cell subtitle linkifies');
assert((extractFunction('applyDescriptionBody').match(/linkifyEmails/g) || []).length >= 2, 'description body linkifies on set and on unchanged re-render');
assert(/document\.querySelectorAll\("#evBandText, #evBody p, \.ev-info-cell \.v"\)\.forEach\(linkifyEmails\)/.test(SOURCE), 'design text sweep covers band text, story paragraphs and info cells');
assert(/addEventListener\("otra:event-rendered", \(\) => linkifyContentEmails\(\)\)/.test(SOURCE), 'design text sweep runs after each render');
assert(!/innerHTML[^\n]*mailto/.test(SOURCE), 'links are never built with innerHTML');

if (failures.length) {
  console.error('FAIL check-override-email-mailto');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('PASS check-override-email-mailto');
