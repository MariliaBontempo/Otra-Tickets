// Event Pricing card amounts ("XCG 500", "XCG 5000") stay on one line.
//
// Strange Bird Thu 8266 had a page edit on its single ticket price saved as
// "XCG \n500"; site-overrides.js applied it with white-space: pre-line, so the
// card showed "XCG" on one line and "500" on the next. The price cell now
// gets that text as one line, and the card CSS never wraps the amount.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const overridesSrc = read("site-overrides.js");

function fakeEl(classes, parent = null) {
  const style = {};
  return {
    textContent: "",
    style,
    classList: { contains: (name) => classes.includes(name) },
    closest(sel) {
      for (let el = this; el; el = el.parent) {
        if (sel.startsWith(".") && el.classList.contains(sel.slice(1))) return el;
      }
      return null;
    },
    parent,
  };
}

async function applyOverrides(selectors, fields) {
  const ctx = {
    document: {
      currentScript: { dataset: { overrideId: "8266" } },
      getElementById: () => null,
      querySelector: (sel) => selectors[sel] || null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {},
    sessionStorage: { getItem: () => "" },
    location: { search: "", pathname: "/strange-bird-thursday", href: "https://otratickets.com/strange-bird-thursday" },
    fetch: async () => ({ ok: true, json: async () => ({ override: { fields } }) }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    URL,
    URLSearchParams,
    setTimeout() {},
  };
  vm.runInNewContext(overridesSrc, ctx);
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
}

const PRICE_KEY = "text:#evRates > div:nth-of-type(1) > div:nth-of-type(2)";
const NOTE_KEY = "text:#evRates > div:nth-of-type(1) > div:nth-of-type(3)";

test("a price edit saved with a line break renders as one line", async () => {
  const card = fakeEl(["ev-rate"]);
  const price = fakeEl(["rp"], card);
  await applyOverrides({ "#evRates > div:nth-of-type(1) > div:nth-of-type(2)": price }, {
    [PRICE_KEY]: { type: "text", value: "XCG \n500" },
  });
  assert.equal(price.textContent, "XCG 500");
  assert.equal(price.style.whiteSpace, undefined);
});

test("other text edits keep their line breaks", async () => {
  const card = fakeEl(["ev-rate"]);
  const note = fakeEl(["rn"], card);
  await applyOverrides({ "#evRates > div:nth-of-type(1) > div:nth-of-type(3)": note }, {
    [NOTE_KEY]: { type: "text", value: "Table for 10\nIncludes 2 bottles" },
  });
  assert.equal(note.textContent, "Table for 10\nIncludes 2 bottles");
  assert.equal(note.style.whiteSpace, "pre-line");
});

test("every event page keeps the price amount on one line", () => {
  for (const page of ["event.html", "rnb.html", "clearboat.html"]) {
    const rule = read(page).match(/\.ev-rate \.rp \{[^}]*\}/);
    assert.ok(rule, `${page} styles .ev-rate .rp`);
    assert.match(rule[0], /white-space:\s*nowrap/, `${page} price amount must not wrap`);
    assert.match(rule[0], /font-size:\s*min\(clamp\(40px, 4\.4vw, 60px\), 18cqi\)/, `${page} price shrinks to fit a narrow card`);
    assert.match(read(page), /\.ev-rate \{ container-type: inline-size;/, `${page} price card is the size container`);
  }
});

test("event.html loads the site-overrides build with the one-line price fix", () => {
  assert.match(read("event.html"), /\/site-overrides\.js\?v=11"/);
});
