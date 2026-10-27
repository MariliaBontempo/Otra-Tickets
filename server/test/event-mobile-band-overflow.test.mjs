// Strange Bird Thu 8266 on a phone: the EVENT DETAILS band holds long text.
// Its "grow to fit" layout only lived in .ev-band:has(...) rules, which
// browsers without :has() drop, so the band stayed a 16:9 box with overflow
// hidden and cut most of the text. Full bleed 100vw sections also added a
// sideways scroll where the scrollbar takes width. Both are covered here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const eventHtml = read("event.html");
const overridesSrc = read("site-overrides.js");

test("root clips the sideways overflow from 100vw full bleed sections", () => {
  assert.match(eventHtml, /html \{ overflow-x: hidden; \}/);
  assert.match(eventHtml, /@supports \(overflow-x: clip\) \{ html \{ overflow-x: clip; \} \}/);
});

test("band grow layout has class rules that do not depend on :has()", () => {
  assert.match(eventHtml, /\.ev-band\.ev-band--grow \{[^}]*aspect-ratio: auto;[^}]*min-height: 620px;/);
  assert.match(eventHtml, /\.ev-band\.ev-band--text \{[^}]*align-items: flex-start;/);
  // The class rules must not share a selector list with :has(), or a browser
  // without :has() drops them too.
  for (const line of eventHtml.split("\n").filter((l) => l.includes(".ev-band--grow {") || l.includes(".ev-band--text {"))) {
    assert.doesNotMatch(line, /:has\(/);
  }
  // They must also sit at the top level of the stylesheet, not inside an
  // @supports or @media block that a browser without :has() could skip.
  const style = eventHtml.slice(eventHtml.indexOf("<style>"), eventHtml.indexOf("</style>"));
  for (const rule of [".ev-band.ev-band--grow {", ".ev-band.ev-band--text {"]) {
    const at = style.indexOf(rule);
    assert.ok(at > 0, rule + " missing");
    const before = style.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, "");
    const depth = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
    assert.equal(depth, 0, rule + " must be a top-level rule");
  }
  assert.match(eventHtml, /@supports not selector\(:has\(a\)\) \{\s*\.ev-band \{ aspect-ratio: auto; min-height: 56\.25vw; \}/);
});

function fakeNode(id, hidden) { return { id, hidden }; }
function fakeBand(children, detailed = false) {
  const classes = new Set();
  return {
    id: "evBandSection",
    hidden: false,
    classes,
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    querySelector(sel) {
      if (sel === ".ev-like.detailed") return detailed ? {} : null;
      return children[sel] || null;
    },
  };
}

function loadOverrides(band) {
  const listeners = {};
  const ctx = {
    document: {
      currentScript: { dataset: {} },
      getElementById: (id) => (id === "evBandSection" ? band : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    },
    window: { addEventListener() {} },
    location: { pathname: "/", search: "", href: "https://otratickets.com/" },
    URL, URLSearchParams, setTimeout, clearTimeout, console,
  };
  vm.createContext(ctx);
  vm.runInContext(overridesSrc, ctx);
  return listeners;
}

test("event render marks a band with visible text as grow + text", () => {
  const band = fakeBand({ "#evBandText": fakeNode("evBandText", false), "#evSponsors": fakeNode("evSponsors", true) });
  const listeners = loadOverrides(band);
  (listeners["otra:event-rendered"] || []).forEach((fn) => fn());
  assert.ok(band.classes.has("ev-band--grow"));
  assert.ok(band.classes.has("ev-band--text"));
});

test("band classes are synced when the script loads after the event rendered", () => {
  const band = fakeBand({ "#evBandText": fakeNode("evBandText", false), "#evSponsors": fakeNode("evSponsors", true) });
  loadOverrides(band); // no otra:event-rendered dispatched
  assert.ok(band.classes.has("ev-band--grow"));
  assert.ok(band.classes.has("ev-band--text"));
});

test("band without text, sponsors or detailed perks keeps the 16:9 box", () => {
  const band = fakeBand({ "#evBandText": fakeNode("evBandText", true), "#evSponsors": fakeNode("evSponsors", true) });
  const listeners = loadOverrides(band);
  (listeners["otra:event-rendered"] || []).forEach((fn) => fn());
  assert.equal(band.classes.size, 0);
});

test("detailed perks or sponsors grow the band without the text class", () => {
  const band = fakeBand({ "#evBandText": fakeNode("evBandText", true), "#evSponsors": fakeNode("evSponsors", false) }, true);
  const listeners = loadOverrides(band);
  (listeners["otra:event-rendered"] || []).forEach((fn) => fn());
  assert.ok(band.classes.has("ev-band--grow"));
  assert.ok(!band.classes.has("ev-band--text"));
});

// Cloudflare keeps /site-overrides.js?v=11 for 4h, which still lacks
// syncBandLayout. Every event page must ask for the build that has it.
test("every event page loads the overrides build with the band sync", () => {
  assert.match(overridesSrc, /function syncBandLayout\(/);
  for (const page of ["event.html", "rnb.html", "clearboat.html"]) {
    const srcs = read(page).match(/site-overrides\.js\?v=\d+"/g) || [];
    assert.deepEqual(srcs, ['site-overrides.js?v=12"'], `${page} loads site-overrides.js?v=12 once`);
  }
});
