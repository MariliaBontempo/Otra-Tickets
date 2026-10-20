import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onRequestGet as getEvent } from "../../functions/api/event.js";
import { forgetGuideStatuses } from "../../functions/_lib/guide-event-hidden.js";
import { ticketSale, ticketSaleState } from "../../functions/_lib/ticket-sale-state.js";

// Bingo Bengo: the page is Guide event 7479 with checkout pointed at 7524
// (the December edition). 7479's own ticket feed is empty while 7524 sells.
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const ticket = (id, name, price, start, end) => ({
  id, name, price, description: "", base_currency: { code: "USD" },
  sale_start_time: start, sale_end_time: end, hide_ticket_availability: true,
});

const feeds = {
  7479: { results: [], addons: [] },
  7524: { results: [
    ticket(455, "Early Bird", 95, iso(now - 70 * DAY), iso(now + 50 * DAY)),
    ticket(456, "General Admission - Regular", 110, iso(now - 70 * DAY), iso(now + 50 * DAY)),
  ], addons: [] },
  // Nothing open yet: two tiers opening on different days.
  7600: { results: [
    ticket(1, "Phase 2", 120, iso(now + 5 * DAY), iso(now + 40 * DAY)),
    ticket(2, "Phase 1", 100, iso(now + 2 * DAY), iso(now + 40 * DAY)),
  ], addons: [] },
  // Mixed windows: one tier over, one selling, one still to open.
  7601: { results: [
    ticket(3, "Early Bird", 80, iso(now - 30 * DAY), iso(now - DAY)),
    ticket(4, "Regular", 100, iso(now - DAY), iso(now + 20 * DAY)),
    ticket(5, "Door", 120, iso(now + 20 * DAY), iso(now + 21 * DAY)),
  ], addons: [] },
  // Every tier closed while the event itself is still ahead.
  7602: { results: [ticket(6, "Regular", 100, iso(now - 30 * DAY), iso(now - DAY))], addons: [] },
};

const detail = (id, title) => ({ id, title, start_date: iso(now + 50 * DAY), end_date: iso(now + 50 * DAY + 3 * 3600e3), is_ticketed: true, is_perennial: false });
const details = { 7479: detail(7479, "Bingo Bengo"), 7600: detail(7600, "Not Yet"), 7601: detail(7601, "Mixed"), 7602: detail(7602, "Closed") };

function kvWith(docs = {}) {
  const byKey = new Map(Object.entries(docs));
  return {
    async list({ prefix } = {}) { return { keys: [...byKey.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    async get(key) { return byKey.has(key) ? byKey.get(key) : null; },
  };
}

async function withUpstream(fn, { feedDown = [] } = {}) {
  forgetGuideStatuses();
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const calls = [];
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const path = url.pathname;
    calls.push(path);
    let m;
    if ((m = path.match(/^\/api\/events\/details\/(\d+)\/$/))) {
      return details[m[1]] ? Response.json(details[m[1]]) : Response.json({ detail: "Not found" }, { status: 404 });
    }
    if ((m = path.match(/^\/api\/ticket\/purchase\/tickets\/(\d+)\/$/))) {
      if (feedDown.includes(m[1])) return new Response("bad gateway", { status: 502 });
      return Response.json(feeds[m[1]] || { results: [], addons: [] });
    }
    return new Response("", { status: 404 });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

async function get(id, docs = {}) {
  const res = await getEvent({
    request: new Request(`https://otratickets.com/api/event?id=${id}`),
    env: { OTRA_API_BASE: "https://otraguide.com/api", OVERRIDES: kvWith(docs) },
    waitUntil() {},
  });
  return { status: res.status, body: await res.json() };
}

const bingoOverride = { "event:7479": { checkoutEventId: "7524" } };

test("a page whose checkout points at another event lists that event's rates, on sale", async () => {
  await withUpstream(async (calls) => {
    const { status, body } = await get("7479", bingoOverride);
    assert.equal(status, 200);
    assert.equal(body.checkoutEventId, "7524");
    assert.deepEqual(body.tickets.map((t) => [t.name, t.price, t.sale]), [
      ["Early Bird", 95, "on_sale"],
      ["General Admission - Regular", 110, "on_sale"],
    ]);
    assert.deepEqual(body.ticketSale, { state: "on_sale", opensAt: null });
    assert.equal(body.isPast, false);
    assert.ok(calls.includes("/api/ticket/purchase/tickets/7524/"));
  });
});

test("without a checkout override the page keeps its own feed and makes no extra call", async () => {
  await withUpstream(async (calls) => {
    const { body } = await get("7601");
    assert.equal(body.checkoutEventId, 7601);
    assert.equal(calls.filter((p) => p.startsWith("/api/ticket/purchase/tickets/")).length, 1);
  });
});

test("not yet on sale: every tier upcoming, the page names the earliest opening", async () => {
  await withUpstream(async () => {
    const { body } = await get("7600");
    assert.equal(body.ticketSale.state, "upcoming");
    assert.equal(body.ticketSale.opensAt, feeds[7600].results[1].sale_start_time);
    assert.deepEqual(body.tickets.map((t) => t.sale), ["upcoming", "upcoming"]);
    assert.equal(body.tickets[1].saleStartsAt, feeds[7600].results[1].sale_start_time);
  });
});

test("mixed sale windows: the page is on sale and each tier says where it stands", async () => {
  await withUpstream(async () => {
    const { body } = await get("7601");
    assert.equal(body.ticketSale.state, "on_sale");
    assert.deepEqual(body.tickets.map((t) => [t.name, t.sale]), [["Early Bird", "ended"], ["Regular", "on_sale"], ["Door", "upcoming"]]);
  });
});

test("every tier closed before the event: sales ended, the event itself is not past", async () => {
  await withUpstream(async () => {
    const { body } = await get("7602");
    assert.equal(body.ticketSale.state, "ended");
    assert.equal(body.isPast, false);
  });
});

test("no ticket types at all stays the plain empty state", async () => {
  await withUpstream(async () => {
    const { body } = await get("7479");
    assert.deepEqual(body.tickets, []);
    assert.deepEqual(body.ticketSale, { state: "none", opensAt: null });
  });
});

test("when the checkout event's feed fails, no rates are shown and nothing is claimed about the sale", async () => {
  await withUpstream(async () => {
    const { status, body } = await get("7601", { "event:7601": { checkoutEventId: "7524" } });
    assert.equal(status, 200);
    assert.deepEqual(body.tickets, []);
    assert.deepEqual(body.ticketSale, { state: "unknown", opensAt: null });
    assert.equal("ticketsUnknown" in body, false);
  }, { feedDown: ["7524"] });
});

test("sale windows: start and end edges, and tickets without a window", () => {
  const at = Date.parse("2026-12-01T12:00:00Z");
  assert.equal(ticketSale({ saleStartsAt: "2026-12-01T12:00:00Z" }, at), "on_sale");
  assert.equal(ticketSale({ saleStartsAt: "2026-12-01T12:00:01Z" }, at), "upcoming");
  assert.equal(ticketSale({ saleEndsAt: "2026-12-01T12:00:00Z" }, at), "ended");
  assert.equal(ticketSale({ name: "Design rate" }, at), "on_sale");
  assert.equal(ticketSale({ saleStartsAt: "not a date" }, at), "on_sale");
  assert.deepEqual(ticketSaleState([], at), { state: "none", opensAt: null });
  assert.deepEqual(ticketSaleState(null, at), { state: "none", opensAt: null });
});

const html = readFileSync(new URL("../../event.html", import.meta.url), "utf8");

test("event.html titles the rates from the sale state, not from the ticket count alone", () => {
  assert.match(html, /"Tickets go on sale " \+ saleDate\(ev\.ticketSale\.opensAt\)/);
  assert.match(html, /"Ticket sales have ended\."/);
  assert.match(html, /t\.sale === "upcoming" \? "On sale " \+ saleDate\(t\.saleStartsAt\)/);
  assert.match(html, /sale === "unknown"[\s\S]{0,200}\$\("evRatesSection"\)\.hidden = true/);
});

test("event.html drops a late checkout loader, and shows an error with a retry when checkout never loads", () => {
  const fn = html.slice(html.indexOf("function loadCheckout("), html.indexOf("})();", html.indexOf("function loadCheckout(")));
  // loadCheckout is called before the script's later declarations are set,
  // so its settle delay must live inside it.
  assert.match(fn, /const CHECKOUT_SETTLE_MS = \d+;/);
  assert.equal(/const CHECKOUT_SETTLE_MS/.test(html.replace(fn, "")), false);
  assert.match(fn, /new MutationObserver/);
  assert.match(fn, /querySelectorAll\("\.otra-loading"\)\.forEach\(\(el\) => el\.remove\(\)\)/);
  assert.match(fn, /addEventListener\("load", markReady\)/);
  assert.match(fn, /OTRA_IFRAME_RESIZE[\s\S]{0,200}markReady\(\)/);
  assert.match(fn, /setTimeout\(fail, CHECKOUT_SETTLE_MS\)/);
  assert.match(fn, /onError: fail/);
  assert.match(fn, /s\.onerror = function \(\) \{[\s\S]{0,120}fail\(\);/);
  assert.match(fn, /Checkout couldn\\u2019t load\./);
  assert.match(fn, /id="evCheckoutRetry"/);
});
