// Event Pricing card amounts ("XCG 500", "XCG 5000") stay on one line.
//
// Strange Bird Thu 8266 had a page edit on its single ticket price saved as
// "XCG \n500"; site-overrides.js applied it with white-space: pre-line, so the
// card showed "XCG" on one line and "500" on the next. The price cell now
// gets that text as one line, the card CSS never wraps the amount, and an
// amount wider than its card shrinks just enough to fit.
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
    const html = read(page);
    const rule = html.match(/\.ev-rate \.rp \{[^}]*\}/);
    assert.ok(rule, `${page} styles .ev-rate .rp`);
    assert.match(rule[0], /white-space:\s*nowrap/, `${page} price amount must not wrap`);
    assert.match(rule[0], /font-size:\s*clamp\(40px, 4\.4vw, 60px\);/, `${page} keeps the design size`);
    assert.match(html, /\.ev-rate \{ min-width: 0;/, `${page} card may be narrower than its amount so the fit can shrink it`);
    assert.match(html, /site-overrides\.js\?v=11"/, `${page} loads the build with the price fit`);
  }
});

// fitPriceAmounts against fake cards whose text width scales with font size,
// like real text. Each case is one card width and one amount width at 60px.
// fitPriceAmounts reads these from the surrounding script.
const FIT_PRELUDE = "let priceCardObserver = null; function queueFitPriceAmounts() {}\n";
const FIT_SRC = ["fitPriceAmounts", "fitPriceAmount"]
  .map((name) => overridesSrc.match(new RegExp(`  function ${name}\\(\\w*\\) \\{[\\s\\S]*?\\n  \\}\\n`))[0])
  .join("\n");

function runFit(cards) {
  const src = FIT_SRC;
  const els = cards.map(({ room, textAt60 }) => {
    const style = { fontSize: "" };
    return {
      style,
      clientWidth: room,
      get scrollWidth() {
        const px = style.fontSize ? parseFloat(style.fontSize) : 60;
        return Math.max(room, Math.ceil((textAt60 * px) / 60));
      },
      textWidth() {
        const px = style.fontSize ? parseFloat(style.fontSize) : 60;
        return (textAt60 * px) / 60;
      },
    };
  });
  const ctx = {
    document: { querySelectorAll: (sel) => (sel === ".ev-rate .rp" ? els : []) },
    getComputedStyle: (el) => ({ fontSize: el.style.fontSize || "60px" }),
  };
  vm.runInNewContext(`${FIT_PRELUDE}${src}\nfitPriceAmounts();`, ctx);
  return els;
}

test("an amount that fits its card keeps the design size", () => {
  const [short] = runFit([{ room: 300, textAt60: 210 }]);
  assert.equal(short.style.fontSize, "");
});

test("an amount wider than its card shrinks just enough to fit on one line", () => {
  // "XCG 10,000" saved as a page edit (all full size) in a narrow four card row.
  const [long] = runFit([{ room: 196, textAt60: 330 }]);
  const px = parseFloat(long.style.fontSize);
  assert.ok(px < 60 && px >= 34, `shrunk to ${px}px`);
  assert.ok(long.textWidth() <= 196, `fits: ${long.textWidth()}px in 196px`);
});

test("refitting after the card grows restores the design size", () => {
  const els = runFit([{ room: 196, textAt60: 330 }]);
  assert.ok(els[0].style.fontSize);
  const src = FIT_SRC;
  els[0].clientWidth = 400;
  vm.runInNewContext(`${FIT_PRELUDE}${src}\nfitPriceAmounts();`, {
    document: { querySelectorAll: () => els },
    getComputedStyle: (el) => ({ fontSize: el.style.fontSize || "60px" }),
  });
  assert.equal(els[0].style.fontSize, "");
});
