// Before You Go (#evInfoSection) on event.html.
//
// The page adds an automatic "Tickets — From …" cell whenever tickets are
// for sale. That cell only repeats the price list, so it must never open
// Before You Go on its own: Strange Bird Thu 8266 / Fri 8267 have
// design.practicalInfo = [] (TJ cleared it) and no dates on the page, and
// used to show a Before You Go holding only "Tickets — From XCG 500".
// Pages with authored cells, or with Date / Time / Availability cells, keep
// the section and the Tickets cell as before.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../../event.html", import.meta.url), "utf8");

function extractFunction(name) {
  const start = html.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `${name} must exist in event.html`);
  const open = html.indexOf("{", html.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`${name} not closed`);
}

const ctx = vm.createContext({});
vm.runInContext(`${extractFunction("practicalInfoCells")}; this.run = practicalInfoCells;`, ctx);
const CURRENCY = { USD: "$" };
const cur = (code) => CURRENCY[code] || (code ? code + " " : "$");
const money = (n) => String(Number(n));
const plain = (value) => JSON.parse(JSON.stringify(value));
const run = (args) => plain(ctx.run({ hasTickets: false, isPast: false, start: null, end: null, cur, money, ...args, hasTickets: Array.isArray(args.ev.tickets) && args.ev.tickets.length > 0 }));

const strangeBirdTickets = [
  { name: "Single ticket", price: "500.00", currency: "XCG" },
  { name: "Tables", price: "500.00", currency: "XCG" },
  { name: "Table of 10", price: "5000.00", currency: "XCG" },
];
const start = { full: "Saturday, September 6", time: "17:00" };
const end = { time: "20:00" };

test("cleared practicalInfo with only the automatic Tickets cell hides Before You Go (Strange Bird 8266/8267)", () => {
  const out = run({ design: { practicalInfo: [], practicalTitle: "" }, ev: { isPerennial: false, tickets: strangeBirdTickets } });
  assert.equal(out.show, false);
  assert.deepEqual(out.cells, []);
});

test("no design and no dates: tickets alone do not open Before You Go", () => {
  const out = run({ design: {}, ev: { isPerennial: false, tickets: strangeBirdTickets } });
  assert.equal(out.show, false);
});

test("authored practicalInfo still shows, with the Tickets cell last (8088 / Iguana shape)", () => {
  const out = run({
    design: { practicalInfo: [{ key: "Location", value: "Landhuis" }, { key: "Dress code", value: "Festive" }] },
    ev: { isPerennial: false, tickets: [{ price: 20, currency: "USD" }] },
  });
  assert.equal(out.show, true);
  assert.deepEqual(out.cells, [["Location", "Landhuis"], ["Dress code", "Festive"], ["Tickets", "From $20"]]);
});

test("authored practicalInfo with no tickets shows without a Tickets cell", () => {
  const out = run({ design: { practicalInfo: [{ key: "Parking", value: "On site" }] }, ev: { isPerennial: false, tickets: [] } });
  assert.equal(out.show, true);
  assert.deepEqual(out.cells, [["Parking", "On site"]]);
});

test("empty practicalInfo on a dated event keeps the automatic Date / Time / Tickets cells (Bingo Bengo 7479)", () => {
  const out = run({
    design: { practicalInfo: [] },
    start,
    end,
    ev: { isPerennial: false, tickets: [{ price: 95, currency: "XCG", sale: "on_sale" }, { price: 110, currency: "XCG", sale: "on_sale" }] },
  });
  assert.equal(out.show, true);
  assert.deepEqual(out.cells, [["Date", "Saturday, September 6"], ["Time", "17:00 — 20:00"], ["Tickets", "From XCG 95"]]);
});

test("perennial tour without design keeps Availability / Location / Tickets", () => {
  const out = run({ design: {}, ev: { isPerennial: true, tickets: [{ price: 45, currency: "USD" }] } });
  assert.equal(out.show, true);
  assert.deepEqual(out.cells, [["Availability", "Flexible dates"], ["Location", "Curaçao"], ["Tickets", "From $45"]]);
});

test("From still quotes only on-sale tiers, and ended tiers never set it", () => {
  const ev = { isPerennial: false, tickets: [{ price: 10, currency: "USD", sale: "ended" }, { price: 30, currency: "USD", sale: "on_sale" }] };
  assert.deepEqual(run({ design: {}, start, end, ev }).cells.at(-1), ["Tickets", "From $30"]);
  const allEnded = { isPerennial: false, tickets: [{ price: 10, currency: "USD", sale: "ended" }] };
  assert.deepEqual(run({ design: {}, start, end, ev: allEnded }).cells.map((c) => c[0]), ["Date", "Time"]);
  assert.deepEqual(run({ design: {}, start, end, isPast: true, ev: allEnded }).cells.at(-1), ["Tickets", "From $10"]);
});

test("the page unhides #evInfoSection only when practicalInfoCells says show", () => {
  const block = html.slice(html.indexOf("// ----- PRACTICAL INFO -----"), html.indexOf("// ----- RATES -----"));
  assert.match(block, /if \(practical\.show\) \{[\s\S]*?\$\("evInfoSection"\)\.hidden = false;/);
  assert.equal((block.match(/\$\("evInfoSection"\)\.hidden = false/g) || []).length, 1);
  assert.match(html, /<section[^>]*id="evInfoSection"[^>]*hidden>/);
});
