// Pencil rich text: staff style page text (font size, color, bold, italic,
// underline) in the pencil editor. Only a tiny markup is stored and served,
// sizes are percents rendered as em (so they follow the template's responsive
// clamp() sizes, capped on phones), and fields without styling stay exactly
// the plain text they always were.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  normalizeRichTextField,
  normalizeRichHeroMeta,
  normalizeRichInfoField,
  parseRichText,
  richTextAllowedForField,
  richTextToPlain,
  sanitizeRichText,
  serializeRichText,
} from "../../functions/_lib/rich-text.js";
import { mergeOverrideSave } from "../../functions/_lib/override-conflict.js";
import { onRequestGet as adminGet, onRequestPut as adminPut } from "../../functions/admin/api/overrides.js";
import { onRequestGet as publicGet } from "../../functions/api/override.js";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const overridesSrc = read("site-overrides.js");
const adminSrc = read("admin/index.html");

const CORPUS = [
  "Francis Sling's <span data-otra-size=\"75\">Book Launch</span> Gala",
  "<b>Bold</b> <i>it</i> <u>under</u> <strong><em>both</em></strong>",
  "<span data-otra-color=\"#1C9EBD\">teal</span> and <span data-otra-color=\"#abc\">short</span>",
  "<span data-otra-size=\"125\" data-otra-color=\"#ff0000\">big red</span>",
  "<span style=\"font-size:80px\" data-otra-size=\"12px\">bad size</span>",
  "<span data-otra-size=\"999\">not allowed</span>",
  "<span style=\"font-size:150%;color:#1c9ebd;position:fixed\">Native format</span>",
  "<span style=\"font-size:1.25em\">Native em format</span>",
  "<span style=\"font-size:24px\">Legacy px converted responsively</span>",
  "<font size=\"5\" color=\"#1c9ebd\">Legacy format</font>",
  "<script>alert(1)</script><b>ok</b>",
  "<img src=x onerror=alert(1)><b onclick=\"x()\">click</b>",
  "<a href=\"javascript:alert(1)\">link</a><em>kept</em>",
  "<style>h1{color:red}</style><u>u</u>",
  "<!-- note --><strong>a &amp; b &lt;c&gt; &quot;q&quot; &#39;s&#39; &nbsp;x</strong>",
  "line one<br>line two<br><br><b>para two</b>",
  "<span data-otra-size=\"125\">line one\n\nline two</span>",
  "<div>one</div><div><b>two</b></div>",
  "<p>first</p><p><em>second</em></p>",
  "<b>unclosed <i>nest",
  "</b></i>stray closers<b>x</b>",
  "<b><b><b><b><b><b><b><b>deep</b></b></b></b></b></b></b></b>",
  "a < b <3 <b>c</b>",
  "<font color=\"#ff0000\" size=\"7\">font tag</font><b>x</b>",
  "<span>no attrs</span> <b></b>plain",
  "<br><br><b>trim</b><br>",
];

function browserLib() {
  const ctx = {
    document: { currentScript: null, addEventListener() {}, querySelectorAll: () => [], getElementById: () => null },
    window: {},
    sessionStorage: { getItem: () => "" },
    location: { search: "", pathname: "/", href: "https://otratickets.com/" },
    fetch: async () => ({ ok: false }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    URL,
    URLSearchParams,
    setTimeout() {},
  };
  vm.runInNewContext(overridesSrc, ctx);
  return ctx.window.otraRichText;
}

test("only the allowed markup survives sanitizing", () => {
  for (const html of CORPUS) {
    const out = sanitizeRichText(html);
    assert.doesNotMatch(out, /<(?!\/?(?:strong|em|u|span|br)\b)/i, html);
    assert.doesNotMatch(out, /on\w+=|style=|href=|src=|javascript:|alert\(|<script|h1\{/i, html);
    const attrs = [...out.matchAll(/<span([^>]*)>/g)].map((m) => m[1]);
    for (const a of attrs) assert.match(a, /^(?: data-otra-size="(?:50|70|75|80|90|100|110|125|150|200)")?(?: data-otra-color="#[0-9a-f]{6}")?$/, html);
  }
  assert.equal(sanitizeRichText("<img src=x onerror=alert(1)>"), "");
  assert.equal(sanitizeRichText("<span data-otra-size=\"999\">x</span>"), "");
  assert.equal(sanitizeRichText("<span data-otra-color=\"#ABC\">x</span>"), '<span data-otra-color="#aabbcc">x</span>');
  assert.equal(sanitizeRichText("<b>a &amp; &lt;b&gt;</b>"), "<strong>a &amp; &lt;b&gt;</strong>");
});

test("the page parser and the server agree on every input", () => {
  const lib = browserLib();
  assert.ok(lib, "site-overrides.js exposes window.otraRichText");
  for (const html of CORPUS) {
    const server = serializeRichText(parseRichText(html));
    assert.equal(lib.serialize(lib.parse(html)), server, html);
    assert.equal(lib.toPlain(lib.parse(html)), richTextToPlain(parseRichText(html)), html);
    assert.equal(lib.normalize(html), sanitizeRichText(html), html);
  }
  assert.deepEqual([...lib.SIZES], [50, 70, 75, 80, 90, 100, 110, 125, 150, 200]);
});

test("plain text is rebuilt from the html; unstyled edits stay plain", () => {
  assert.deepEqual(normalizeRichTextField("Hello", "Hello"), { value: "Hello", html: "" });
  assert.deepEqual(normalizeRichTextField("Old text", ""), { value: "Old text", html: "" });
  assert.deepEqual(
    normalizeRichTextField("stale", "Book <span data-otra-size=\"75\">Launch</span><br><br>Gala"),
    { value: "Book Launch\n\nGala", html: 'Book <span data-otra-size="75">Launch</span><br><br>Gala' },
  );
  assert.equal(normalizeRichTextField("x", "<b>" + "a".repeat(50000) + "</b>").html, "");
});

test("all text pencils accept rich formatting; info composites keep their parts", () => {
  assert.equal(richTextAllowedForField("text:#evMeta > span:nth-of-type(1)", { type: "text", value: "Sun" }), true);
  assert.equal(richTextAllowedForField("text:main > #evMeta > span", { type: "text", value: "Sun" }), true);
  assert.equal(richTextAllowedForField("text:#evInfoGrid > div:nth-of-type(1)", { type: "text", value: 'otra-info-cell:{"title":"a"}' }), false);
  assert.equal(richTextAllowedForField("text:#evTitle", { type: "text", value: "Gala" }), true);
  assert.equal(richTextAllowedForField("image:#evHeroImg", { type: "image", value: "/x.jpg" }), false);
});

test("a style only change counts as a change for the conflict check", () => {
  const before = { type: "text", value: "Gala" };
  const styled = { type: "text", value: "Gala", html: "<strong>Gala</strong>" };
  const current = { updatedAt: "2026-11-05T18:00:00.000Z", fields: { "text:#evTitle": { type: "text", value: "Gala", html: "<em>Gala</em>" } } };
  const result = mergeOverrideSave(current, { fields: { "text:#evTitle": styled } }, { updatedAt: "2026-11-05T17:00:00.000Z", top: {}, fields: { "text:#evTitle": before } });
  assert.deepEqual(result.conflictKeys, ["text:#evTitle"]);
});

// ---- Admin save and public serve ------------------------------------------
function makeKv(records = {}) {
  const store = new Map(Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix }) { return { keys: [...store.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    raw(key) { const raw = store.get(key); return raw === undefined ? null : JSON.parse(raw); },
  };
}

test("admin save keeps clean rich html and serves it sanitized", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/users/user-role/")) return { ok: true, json: async () => ({ is_staff_or_admin: true, role: "staff" }) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const DRAFT = "draft-1793000000000-richtest";
    const kv = makeKv();
    const env = { OVERRIDES: kv, OTRA_API_URL: "https://og.test/api" };
    const headers = { authorization: "Bearer t", "content-type": "application/json" };
    const put = await adminPut({
      request: new Request(`https://otratickets.com/admin/api/overrides?id=${DRAFT}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          fields: {
            "text:#evTitle": { type: "text", value: "ignored", html: "Francis <span data-otra-size=\"75\" onclick=\"x()\">Sling</span><script>alert(1)</script>" },
            "text:#evTag": { type: "text", value: "Plain tag", html: "Plain tag" },
            "text:#evSub": { type: "text", value: "Native font size", html: '<span style="font-size:150%">Native font size</span>' },
            "text:#evMeta > span:nth-of-type(1)": { type: "text", value: "Sun", html: "<b>Sun</b>" },
          },
          base: { updatedAt: null, top: {}, fields: {} },
        }),
      }),
      env,
    });
    assert.equal(put.status, 200, await put.clone().text());
    const stored = kv.raw(`event:${DRAFT}`);
    assert.deepEqual(stored.fields["text:#evTitle"], { type: "text", value: "Francis Sling", html: 'Francis <span data-otra-size="75">Sling</span>' });
    assert.deepEqual(stored.fields["text:#evTag"], { type: "text", value: "Plain tag" });
    assert.deepEqual(stored.fields["text:#evSub"], { type: "text", value: "Native font size", html: '<span data-otra-size="150">Native font size</span>' });
    const freshNative = (await (await publicGet({request:new Request(`https://otratickets.com/api/override?id=${DRAFT}`),env})).json()).override.fields["text:#evSub"];
    assert.equal(freshNative.html, stored.fields["text:#evSub"].html);
    assert.equal(stored.fields["text:#evMeta > span:nth-of-type(1)"].html, "<strong>Sun</strong>");

    // Even html written to KV some other way is cleaned on the way out.
    stored.fields["text:#evSub"] = { type: "text", value: "x", html: "<img src=x onerror=alert(1)><u>x</u>" };
    await kv.put(`event:${DRAFT}`, JSON.stringify(stored));
    const res = await publicGet({ request: new Request(`https://otratickets.com/api/override?id=${DRAFT}`), env });
    const served = (await res.json()).override.fields;
    assert.equal(served["text:#evSub"].html, "<u>x</u>");
    assert.equal(served["text:#evTitle"].value, "Francis Sling");
    assert.equal(served["text:#evTag"].html, undefined);

    const got = await adminGet({ request: new Request(`https://otratickets.com/admin/api/overrides?id=${DRAFT}`, { headers }), env });
    assert.equal((await got.json()).override.fields["text:#evTitle"].html, 'Francis <span data-otra-size="75">Sling</span>');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- Page rendering ---------------------------------------------------------
function fakeDoc() {
  const head = makeNode("head");
  const doc = {
    head,
    documentElement: makeNode("html"),
    byId: {},
    createElement: (tag) => makeNode(tag, doc),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: String(text), get textContent() { return this.nodeValue; } }),
    getElementById: (id) => doc.byId[id] || null,
  };
  head.ownerDocument = doc;
  head.appendChild = (child) => { if (child.id) doc.byId[child.id] = child; head.childNodes.push(child); return child; };
  return doc;
}

function makeNode(tag, doc, classes = []) {
  const props = {};
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    childNodes: [],
    attrs: {},
    id: "",
    classList: { contains: (name) => classes.includes(name) || String(node.className || "").split(/\s+/).includes(name) },
    className: "",
    style: { setProperty(name, value) { props[name] = value; }, getPropertyValue: (name) => props[name] || "", props },
    get firstChild() { return node.childNodes[0] || null; },
    get children() { return node.childNodes.filter((c) => c.nodeType === 1); },
    appendChild(child) { child.parentNode = node; node.childNodes.push(child); return child; },
    removeChild(child) { node.childNodes = node.childNodes.filter((c) => c !== child); return child; },
    insertBefore(child, ref) { const i = node.childNodes.indexOf(ref); node.childNodes.splice(i < 0 ? node.childNodes.length : i, 0, child); child.parentNode = node; return child; },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return node.attrs[name] ?? null; },
    hasAttribute(name) { return name in node.attrs; },
    querySelectorAll: () => [],
    querySelector: () => null,
    closest(sel) {
      for (let el = node; el; el = el.parentEl) {
        if (sel.split(",").some((s) => s.trim().startsWith(".") && !s.includes(" ") && el.classList.contains(s.trim().slice(1)))) return el;
      }
      return null;
    },
    get textContent() { return node.childNodes.map((c) => c.textContent).join(""); },
    set textContent(value) { node.childNodes = [{ nodeType: 3, nodeValue: String(value), get textContent() { return this.nodeValue; } }]; },
    get innerHTML() { throw new Error("innerHTML must not be read"); },
    set innerHTML(value) { if (value) throw new Error("rich text must never be set through innerHTML"); node.childNodes = []; },
  };
  return node;
}

function outline(node) {
  if (node.nodeType === 3) return node.nodeValue;
  const tag = node.tagName.toLowerCase();
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<${tag}${attrs}>${node.childNodes.map(outline).join("")}</${tag}>`;
}

async function applyFields(selectors, fields, doc) {
  const ctx = {
    document: {
      ...doc,
      currentScript: { dataset: { overrideId: "draft-1793000000000-francis" } },
      querySelector: (sel) => selectors[sel] || null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {},
    sessionStorage: { getItem: () => "" },
    location: { search: "", pathname: "/event", href: "https://otratickets.com/event" },
    fetch: async () => ({ ok: true, json: async () => ({ override: { fields } }) }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    URL,
    URLSearchParams,
    setTimeout() {},
  };
  vm.runInNewContext(overridesSrc, ctx);
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
}

test("a styled title renders as elements with em based sizes, never innerHTML", async () => {
  const doc = fakeDoc();
  const title = makeNode("h1", doc);
  title.textContent = "Francis Sling's Book Launch Gala";
  await applyFields({ "#evTitle": title }, {
    "text:#evTitle": { type: "text", value: "Francis Sling's Book Launch Gala", html: 'Francis Sling\'s <span data-otra-size="75" data-otra-color="#1c9ebd">Book Launch</span> <strong>Gala</strong>' },
  }, doc);
  assert.equal(
    outline(title),
    '<h1 data-otra-rich="1">Francis Sling\'s <span data-otra-size="75" data-otra-color="#1c9ebd">Book Launch</span> <strong>Gala</strong></h1>',
  );
  const span = title.childNodes[1];
  assert.equal(span.style.props["--otra-fs"], "0.75");
  assert.equal(span.style.color, "#1c9ebd");
  assert.equal(span.className, "otra-rt");
  const css = doc.byId["otra-rich-text-style"].textContent;
  assert.ok(css.includes("font-size:calc(1em * var(--otra-fs, 1) / var(--otra-parent-fs, 1))"));
  assert.ok(css.includes("@media (max-width: 620px)") && css.includes("min(var(--otra-fs, 1), 1.2) / min(var(--otra-parent-fs, 1), 1.2)"));
  assert.doesNotMatch(css, /\d+px\s*[;}]/, "no fixed px font sizes");
});

test("old pages without rich markup look exactly as before", async () => {
  const doc = fakeDoc();
  const title = makeNode("h1", doc);
  const tag = makeNode("p", doc);
  await applyFields({ "#evTitle": title, "#evTag": tag }, {
    "text:#evTitle": { type: "text", value: "Francis Sling's Book Launch Gala" },
    "text:#evTag": { type: "text", value: "Line one\nLine two", html: "" },
  }, doc);
  assert.equal(outline(title), "<h1>Francis Sling's Book Launch Gala</h1>");
  assert.equal(title.childNodes.length, 1);
  assert.equal(tag.textContent, "Line one\nLine two");
  assert.equal(tag.style.whiteSpace, "pre-line");
  assert.equal(doc.byId["otra-rich-text-style"], undefined, "no rich style on pages without styling");
});

test("the story body keeps paragraphs and price labels can be styled", async () => {
  const doc = fakeDoc();
  const body = makeNode("div", doc, ["ev-body"]);
  const card = makeNode("div", doc, ["ev-rate"]);
  const price = makeNode("div", doc, ["rp"]);
  price.parentEl = card;
  await applyFields({ "#evBody": body, "#evRates > div:nth-of-type(1) > div:nth-of-type(2)": price }, {
    "text:#evBody": { type: "text", value: "One\n\nTwo", html: "<em>One</em><br><br>Two<br>still two" },
    "text:#evRates > div:nth-of-type(1) > div:nth-of-type(2)": { type: "text", value: "XCG 500", html: "<b>XCG 500</b>" },
  }, doc);
  assert.equal(outline(body), '<div data-otra-rich="1"><p><em>One</em></p><p>Two<br></br>still two</p></div>' );
  assert.equal(price.textContent, "XCG 500");
  assert.equal(price.childNodes.length, 1);
  assert.equal(price.childNodes[0].tagName, "STRONG");
});

test("the admin pencil opens the rich editor, with no title size slider left", () => {
  assert.match(adminSrc, /id="richText" contenteditable="true"/);
  assert.match(adminSrc, /id="richSize"/);
  assert.match(adminSrc, /id="richColor" type="color"/);
  assert.match(adminSrc, /data-rich-cmd="bold"/);
  assert.ok(adminSrc.includes("richTextMode = !isRename && isRichTextField(activeField)"));
  assert.match(adminSrc, /if \(html\) next\.fields\[storageKey\]\.html = html;/);
  assert.doesNotMatch(adminSrc, /titleSize|Title size/);
  assert.ok(adminSrc.includes('id="richInfoTitle" contenteditable="true"'));
  assert.ok(adminSrc.includes('id="richInfoSubtitle" contenteditable="true"'));
  // Sizes offered are the same as the page allows.
  const offered = [...adminSrc.matchAll(/<option value="(\d+)">/g)].map((m) => Number(m[1])).filter((n) => n !== 100);
  assert.deepEqual(offered.filter((n) => [50, 70, 75, 80, 90, 110, 125, 150, 200].includes(n)), [50, 70, 75, 80, 90, 110, 125, 150, 200]);
});


test("malicious deep nesting cannot exhaust the parser stack", () => {
  const html = "<b>".repeat(6000) + "x" + "</b>".repeat(3000);
  const clean = sanitizeRichText(html);
  assert.ok(clean.length < 120, clean);
  const lib = browserLib();
  assert.equal(lib.normalize(html), clean);
  assert.ok(clean.includes("x"));
});

test("nested font sizes override instead of multiply", () => {
  const lib = browserLib();
  const doc = fakeDoc();
  const title = makeNode("h1", doc);
  lib.render(title, '<span data-otra-size="150">A <span data-otra-size="75">B</span></span>', { linkify: false });
  const outer = title.childNodes[0];
  const inner = outer.childNodes[1];
  assert.equal(outer.style.props["--otra-fs"], "1.5");
  assert.equal(outer.style.props["--otra-parent-fs"], "1");
  assert.equal(inner.style.props["--otra-fs"], "0.75");
  assert.equal(inner.style.props["--otra-parent-fs"], "1.5");
});

test("information cells sanitize each rich part and preserve the other part", () => {
  const value = 'otra-info-cell:{"title":"Meeting point","subtitle":"Cruise Terminal"}';
  const rich = normalizeRichInfoField(value, { title: '<u>Meeting point</u>', subtitle: '<span data-otra-color="#ABC" onclick="bad()">Cruise Terminal</span><script>bad()</script>' });
  assert.equal(rich.value, value);
  assert.deepEqual(rich.htmlParts, { title: '<u>Meeting point</u>', subtitle: '<span data-otra-color="#aabbcc">Cruise Terminal</span>' });
  assert.equal(normalizeRichInfoField('otra-info-cell:null', {}), null);
  assert.equal(normalizeRichInfoField('otra-info-cell:[]', {}), null);
  assert.equal(normalizeRichInfoField(value, { title: "<img src=x onerror=bad()>" }), null);
  assert.deepEqual(normalizeRichInfoField(value, { title: "<u>Other title</u>" }).htmlParts, { title: "<u>Other title</u>" });
});


test("a whole-story style preserves blank-line paragraphs inside the span", () => {
  const lib = browserLib();
  const doc = fakeDoc();
  const body = makeNode("div", doc, ["ev-body"]);
  lib.render(body, '<span data-otra-size="125">First paragraph\n\nSecond paragraph</span>', { paragraphs: true, linkify: false });
  assert.equal(body.children.length, 2);
  assert.equal(body.children[0].tagName, "P");
  assert.equal(body.children[0].textContent, "First paragraph");
  assert.equal(body.children[1].textContent, "Second paragraph");
  assert.equal(body.children[1].children[0].getAttribute("data-otra-size"), "125");
});

test("formatting alone skips sync but saving unchanged text retries a failed sync", () => {
  const body = /function isStyleOnlyEdit\([^)]*\) \{([\s\S]*?)\n  \}/.exec(adminSrc)[1];
  const styleOnly = new Function("beforeValue", "afterValue", "beforeFormatting", "afterFormatting", body);
  assert.equal(styleOnly("$45", "$50", "", ""), false, "real price edit syncs");
  assert.equal(styleOnly("$50", "$50", "", '<span data-otra-size="125">$50</span>'), true, "only style change skips sync");
  assert.equal(styleOnly("$50", "$50", "", ""), false, "after sync401, reopen + unchanged Save retries sync");
  const html = '<span data-otra-size="125">$50</span>';
  assert.equal(styleOnly("$50", "$50", html, html), false, "unchanged styled field can retry sync too");
  assert.equal(styleOnly("August 9, 2026", "August 10, 2026", "", ""), false, "real date edit syncs");
  assert.ok(/if \(!styleOnly\) \{\s*await maybeSyncTicketPrice\(savedField, savedValue\);\s*await maybeSyncEventDate/.test(adminSrc));
});


test("ordinary HTML font-size survives normalization, storage and reread as responsive metadata", () => {
  for (const input of ['<span style="font-size:150%">Gala</span>', '<span style="font-size:1.5em">Gala</span>', '<span style="font-size:24px">Gala</span>', '<font size="5">Gala</font>']) {
    const saved = normalizeRichTextField("Gala", input);
    assert.equal(saved.html, '<span data-otra-size="150">Gala</span>');
    const loaded = normalizeRichTextField(saved.value, JSON.parse(JSON.stringify(saved)).html);
    assert.deepEqual(loaded, saved);
    assert.equal(browserLib().normalize(input), saved.html);
  }
});

test("hero rich text keeps card/page day-time normalization across formatting boundaries", () => {
  const rich = normalizeRichTextField("", '<strong>Wednesday</strong> to <span data-otra-color="#1c9ebd">Sunday</span>: 12:00 PM');
  const display = normalizeRichHeroMeta(rich);
  assert.equal(display.value, "Wednesday to Sunday · 12:00 PM");
  assert.equal(display.html, '<strong>Wednesday</strong> to <span data-otra-color="#1c9ebd">Sunday · </span>12:00 PM');
  const twice = normalizeRichHeroMeta(display);
  assert.deepEqual(twice, display);
  assert.equal(normalizeRichHeroMeta(normalizeRichTextField("", '<u>Mon</u>: 9 AM · <em>Sat</em>: 10 AM')).value, 'Mon · 9 AM · Sat · 10 AM');
});

test("rich wrapper spans inherit typography instead of matching R&B host label CSS", () => {
  const lib = browserLib(), doc = fakeDoc(), name = makeNode("b", doc);
  lib.render(name, '<span data-otra-color="#1c9ebd">Lloyd De Meza</span>', {linkify:false});
  const css = doc.byId["otra-rich-text-style"].textContent;
  assert.ok(css.includes('[data-otra-rich] .otra-rt{font-weight:inherit;letter-spacing:inherit;text-transform:inherit;font-style:inherit;color:inherit}'));
  assert.ok(css.includes('[data-otra-rich] .otra-rt:not([data-otra-size]){font-size:inherit}'));
});


test("rich hero separators keep their spacing even under a formatting span", () => {
  const html = read("event.html");
  assert.ok(/\.ev-hero-meta > span \.dot-inline\s*\{[^}]*margin:\s*0 22px/.test(html));
});

test("reopening with caret on contenteditable root hydrates saved80%, not100%", () => {
  const start = adminSrc.indexOf("  function updateRichToolbar() {");
  const end = adminSrc.indexOf('\n  document.addEventListener("selectionchange"', start);
  const controls = { richSize: { value: "100" }, richColor: { value: "#000000" } };
  const root = { nodeType: 1, childNodes: [], contains: () => true };
  const outer = { nodeType: 1, parentElement: root, getAttribute: () => "80", closest: (selector) => selector === "[data-otra-size]" ? outer : null };
  const text = { nodeType: 3, parentElement: outer };
  root.childNodes = [outer];root.firstChild = outer;outer.firstChild = text;
  const context = { richTextMode: true, richEditor: () => root, $: (id) => controls[id], window: { getSelection: () => ({ rangeCount: 1, getRangeAt: () => ({ startContainer: root, startOffset: 0 }) }) } };
  vm.runInNewContext(adminSrc.slice(start, end) + '\nupdateRichToolbar();', context);
  assert.equal(controls.richSize.value, "80");
  assert.ok(adminSrc.includes('el.style.fontSize = ""'), "changing size removes native descendant font-size too");
});
