// Oracle: a hero line (#evMeta) item edited or authored blank is hidden with
// its separator on the event page, so "A · · B" reads "A · B", and the page
// shows the same items as the homepage card schedule line.
// Run: node scripts/check-hero-meta-empty-items.mjs

import fs from "node:fs";
import vm from "node:vm";
import { editedScheduleParts, metaItemSelector } from "../functions/_lib/schedule-line.js";
import { heroMetaItemText, heroMetaItems } from "../functions/_lib/hero-meta-text.js";

const SOURCE = fs.readFileSync(new URL("../site-overrides.js", import.meta.url), "utf8");
const EVENT_HTML = fs.readFileSync(new URL("../event.html", import.meta.url), "utf8");
const ADMIN_HTML = fs.readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");

const failures = [];
let checks = 0;
const assert = (condition, message) => {
  checks += 1;
  if (!condition) failures.push(message);
};
const eq = (actual, expected, message) =>
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);

// Minimal DOM: just what tidyMetaLine and renderMeta touch.
class Text {
  constructor(text) { this.nodeType = 3; this.textContent = text; }
}
class El {
  constructor(tag, className = "") {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.childNodes = [];
    this.attrs = new Map();
    this.hidden = false;
    const self = this;
    this.classList = { contains: (name) => self.className.split(/\s+/).includes(name) };
  }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value) { this.childNodes = value ? [new Text(String(value))] : []; }
  set innerHTML(value) { this.childNodes = []; }
  appendChild(node) { this.childNodes.push(node); return node; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
}

let host = null;
const document = {
  createElement: (tag) => new El(tag),
  createTextNode: (text) => new Text(text),
  getElementById: (id) => (id === "evMeta" ? host : null),
  addEventListener() {},
  querySelector: () => null,
};
const window = {};
vm.runInNewContext(SOURCE, {
  window,
  document,
  location: { search: "", pathname: "/qa" },
  URLSearchParams,
  fetch: () => Promise.resolve({ ok: false }),
  setTimeout,
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
});
const tidy = window.otraTidyMetaLine;
assert(typeof tidy === "function", "site-overrides.js exposes the hero line tidy helper");

// The real event.html renderMeta, run over the fake DOM.
const renderSource = EVENT_HTML.match(/function renderMeta\(host, parts\) \{[\s\S]*?\n      \}\n/);
assert(renderSource, "event.html still defines renderMeta");
const renderMeta = vm.runInNewContext(`(${renderSource[0]})`, { document, window });

// Build the line like the page: render the items as /api/event serves them,
// then apply the per span text edits as /api/override serves them, the way
// site-overrides.js does (textContent on the selected span), then tidy. Both
// endpoints show an item through heroMetaItemText ("Days · times").
function page(items, edits = {}) {
  host = new El("div", "ev-hero-meta");
  renderMeta(host, heroMetaItems(items));
  const spans = host.children;
  for (const [index, value] of Object.entries(edits)) {
    const span = spans[Number(index) * 2];
    if (span) span.textContent = heroMetaItemText(value);
  }
  tidy(host);
  return host;
}
const visible = (el) => el.children.filter((child) => !child.hidden && !child.classList.contains("otra-admin-edit-btn")).map((child) => child.textContent);
const shown = (el) => (el.hidden ? "" : visible(el).join(" "));
const fieldsFor = (edits) => ({
  fields: Object.fromEntries(Object.entries(edits).map(([i, v]) => [`text:${metaItemSelector(Number(i))}`, { type: "text", value: v }])),
});

const cases = [
  { name: "middle item emptied (the Water Bikes case)", items: ["Midday tours", "1 hour", "From $60"], edits: { 0: "Wednesday to Sunday: 12:00 PM & 1:00 PM", 1: "" }, want: "Wednesday to Sunday · 12:00 PM & 1:00 PM · From $60" },
  { name: "authored weekday range with times", items: ["Wednesday to Sunday: 12:00 PM & 1:00 PM", "1 hour", "From $60"], edits: {}, want: "Wednesday to Sunday · 12:00 PM & 1:00 PM · 1 hour · From $60" },
  { name: "single day with a time", items: ["Saturday: 10:00 PM", "From $95"], edits: {}, want: "Saturday · 10:00 PM · From $95" },
  { name: "dated one time event", items: ["Sat, Dec 13", "9:00 PM", "From $95"], edits: {}, want: "Sat, Dec 13 · 9:00 PM · From $95" },
  { name: "dated colon stays", items: ["Dec 31: 9 PM", "From $40"], edits: {}, want: "Dec 31: 9 PM · From $40" },
  { name: "multiple dates", items: ["Dec 13 & Dec 20", "8:00 PM"], edits: {}, want: "Dec 13 & Dec 20 · 8:00 PM" },
  { name: "times only", items: ["12:00 PM & 1:00 PM", "1 hour"], edits: {}, want: "12:00 PM & 1:00 PM · 1 hour" },
  { name: "days only", items: ["Wednesday to Sunday", "1 hour"], edits: {}, want: "Wednesday to Sunday · 1 hour" },
  { name: "recurring every week", items: ["Flexible dates"], edits: { 0: "Every Friday: 6:00 PM" }, want: "Every Friday · 6:00 PM" },
  { name: "label and title colons stay", items: ["Doors: 7 PM", "Saturday: The Party"], edits: {}, want: "Doors: 7 PM · Saturday: The Party" },
  { name: "Papiamentu days", items: ["Djarason te djadumingu: 12:00", "From $60"], edits: {}, want: "Djarason te djadumingu · 12:00 · From $60" },
  { name: "whitespace only item", items: ["A", "B", "C"], edits: { 1: "   " }, want: "A · C" },
  { name: "first item empty", items: ["A", "B", "C"], edits: { 0: "" }, want: "B · C" },
  { name: "last item empty", items: ["A", "B", "C"], edits: { 2: " " }, want: "A · B" },
  { name: "two neighbours empty", items: ["A", "B", "C", "D"], edits: { 1: "", 2: "" }, want: "A · D" },
  { name: "all but one empty", items: ["A", "B", "C"], edits: { 0: "", 2: "" }, want: "B" },
  { name: "single item kept", items: ["Daily"], edits: {}, want: "Daily" },
  { name: "nothing empty", items: ["A", "B"], edits: {}, want: "A · B" },
  { name: "authored blank item", items: ["A", "", "B"], edits: {}, want: "A · B" },
];
for (const c of cases) {
  const el = page(c.items, c.edits);
  eq(shown(el), c.want, `page: ${c.name}`);
  eq(el.hidden, false, `page: ${c.name} keeps the line`);
  const dots = el.children.filter((child) => child.classList.contains("dot") && !child.hidden).length;
  const items = el.children.filter((child) => !child.classList.contains("dot") && !child.hidden).length;
  eq(dots, Math.max(items - 1, 0), `page: ${c.name} has one separator between visible items`);
  // Same items as the homepage card.
  eq(visible(el).filter((t) => t !== "·").map((t) => t.trim()), editedScheduleParts(c.items, fieldsFor(c.edits)), `card parity: ${c.name}`);
  eq(el.children.length, c.items.length * 2 - 1, `page: ${c.name} keeps every span so saved selectors still match`);
}

// All items empty: nothing renders, no stray dots.
{
  const el = page(["A", "B", "C"], { 0: "", 1: " ", 2: "" });
  eq(el.hidden, true, "all items empty hides the line");
  eq(visible(el), [], "all items empty shows no item and no dot");
  eq(editedScheduleParts(["A", "B", "C"], fieldsFor({ 0: "", 1: " ", 2: "" })), [], "card parity: all items empty");
  const single = page(["Daily"], { 0: "" });
  eq(single.hidden, true, "a single item emptied hides the line");
}

// Editing a blank item back restores it and its separator.
{
  const el = page(["A", "B", "C"], { 1: "" });
  el.children[2].textContent = "B again";
  tidy(el);
  eq(shown(el), "A · B again · C", "an item edited back shows again with its separators");
  const all = page(["A"], { 0: "" });
  all.children[0].textContent = "Back";
  tidy(all);
  eq([all.hidden, shown(all)], [false, "Back"], "a hidden line shows again once an item has text");
}

// Admin editor buttons inside a span are not text.
{
  const el = page(["A", "B", "C"], { 1: "" });
  const btn = new El("button", "otra-admin-edit-btn");
  el.children[2].appendChild(btn);
  tidy(el);
  eq(shown(el), "A · C", "a pencil inside a blank item does not make it visible text");
  const withPencil = page(["A", "B"]);
  withPencil.appendChild(new El("button", "otra-admin-edit-btn"));
  tidy(withPencil);
  eq(shown(withPencil), "A · B", "an admin button on the line is ignored");
}

// A days · times item: its own dot is wrapped like a separator, the text and
// the saved edit comparison stay the same, and re rendering is stable.
{
  const el = page(["Midday tours", "1 hour", "From $60"], { 0: "Wednesday to Sunday: 12:00 PM & 1:00 PM", 1: "" });
  const first = el.children[0];
  eq(first.textContent, "Wednesday to Sunday · 12:00 PM & 1:00 PM", "inline dot: the item text is unchanged");
  eq(first.childNodes.map((n) => (n.nodeType === 1 ? `[${n.className}]` : n.textContent)), ["Wednesday to Sunday", "[dot dot-inline]", "12:00 PM & 1:00 PM"], "inline dot: wrapped as a separator span");
  eq(first.children[0].textContent, " · ", "inline dot: the wrapped dot keeps its spaces for the editor text");
  tidy(el);
  tidy(el);
  eq(first.children.length, 1, "inline dot: tidying again does not wrap twice");
  eq(el.children.filter((c) => c.classList.contains("dot")).length, 2, "inline dot: line separators are still direct children only");
  const two = page(["Mon to Fri: 9 AM · Sat: 10 AM"]);
  eq(two.children[0].children.length, 3, "inline dot: every inner dot is wrapped");
  eq(two.children[0].textContent, "Mon to Fri · 9 AM · Sat · 10 AM", "inline dot: several dots keep the text");
  const plain = page(["Doors: 7 PM", "Sat, Dec 13"]);
  eq(plain.children[0].children.length + plain.children[2].children.length, 0, "inline dot: items without an inner dot stay plain text");
  const withPencil = page(["A", "B"]);
  withPencil.children[0].textContent = "Daily · 9 AM";
  withPencil.children[0].appendChild(new El("button", "otra-admin-edit-btn"));
  tidy(withPencil);
  eq(withPencil.children[0].children.length, 1, "inline dot: an item holding an admin button is left alone");
}
assert(/\.ev-hero-meta > span > \.dot-inline \{ display: inline-block; margin: 0 22px; \}/.test(EVENT_HTML), "event.html spaces an inner dot like the line gap");
assert(/INLINE_DOT = " · "/.test(SOURCE), "site-overrides.js uses the same separator as hero-meta-text.js");

// The whole line replaced with one text edit.
{
  host = new El("div", "ev-hero-meta");
  host.textContent = "  ";
  tidy(host);
  eq(host.hidden, true, "a host edited to blank text hides");
  host.textContent = "Every day";
  tidy(host);
  eq(host.hidden, false, "a host with text shows");
}

// Wiring: the page calls the helper, site-overrides runs it after each pass
// and on re-render, the CSS hides it for real, and the admin keeps a blank
// item reachable so it can be edited back.
assert(/renderMeta[\s\S]*otraTidyMetaLine\(host\)/.test(EVENT_HTML), "event.html renderMeta calls the tidy helper");
assert(/\.ev-hero-meta\[hidden\], \.ev-hero-meta > \[hidden\] \{ display: none !important; \}/.test(EVENT_HTML), "event.html hides hidden hero line nodes even with author display rules");
assert(/tidyMetaLine\(\);\s*\n\s*const remaining = Object\.keys\(fields\)/.test(SOURCE), "site-overrides.js tidies after every pass of page edits");
assert(/addEventListener\("otra:event-rendered", \(\) => tidyMetaLine\(\)\)/.test(SOURCE), "site-overrides.js tidies again when the page re-renders");
assert(/\.ev-hero-meta > span\[data-otra-meta-empty\]:not\(\.dot\) \{ display: inline-block !important;/.test(ADMIN_HTML), "admin preview keeps a blank item reachable");

if (failures.length) {
  console.error(`hero meta empty items: ${failures.length} of ${checks} checks failed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`hero meta empty items: ${checks} checks passed`);
