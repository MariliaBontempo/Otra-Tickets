import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as getEvent } from "../../functions/api/event.js";
import { forgetGuideStatuses } from "../../functions/_lib/guide-event-hidden.js";
import {
  FLIGHT_RELEASE_GATES, flightReleaseGate, groupSellableRemaining, heldTierReleased, withHeldTiersHidden,
} from "../../functions/_lib/flight-release-gate.js";

// Strange Bird Saturday (Guide 8270): Flight 3 stays off the page until
// Flight 1 and Flight 2 both have no sellable tickets left.
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const OPEN = [iso(now - 10 * DAY), iso(now + 10 * DAY)];
const LATER = [iso(now + 10 * DAY), iso(now + 20 * DAY)];

const tt = (id, parent, name, remaining, [start, end] = OPEN, price = 25) => ({
  id, name, price, event: 8270, description: "", base_currency: { code: "XCG" },
  sale_start_time: start, sale_end_time: end, parent_ticket_type: parent,
  remaining_quantity: remaining, hide_ticket_availability: true,
});
const F1 = "Flight 1 · 6:00–7:00 PM Family-Friendly";
const F2 = "Flight 2 · 7:30–8:30 PM Live Show";
const F3 = "Flight 3 · 9:00–10:00 PM Live Show";
const feedOf = ({ f1 = 250, f2 = 250, f3 = 250, regular = false } = {}) => ({
  results: regular
    ? [tt(547, 538, `${F1} · Regular`, f1, OPEN, 35), tt(548, 541, `${F2} · Regular`, f2, OPEN, 35), tt(549, 543, `${F3} · Regular`, f3, OPEN, 35)]
    : [tt(539, 538, `${F1} · Early Bird`, f1), tt(542, 541, `${F2} · Early Bird`, f2), tt(544, 543, `${F3} · Early Bird`, f3)],
  addons: [],
});
const gate = FLIGHT_RELEASE_GATES["8270"];

test("only Guide 8270 is gated", () => {
  assert.ok(flightReleaseGate("8270"));
  assert.ok(flightReleaseGate(8270));
  assert.equal(flightReleaseGate("7567"), null);
  assert.equal(flightReleaseGate(""), null);
  assert.equal(flightReleaseGate("constructor"), null);
  assert.equal(flightReleaseGate(undefined), null);
});

test("both flights selling: Flight 3 held", () => {
  assert.equal(heldTierReleased(feedOf(), gate, now), false);
});

test("only one flight sold out: Flight 3 still held, either way round", () => {
  assert.equal(heldTierReleased(feedOf({ f1: 0 }), gate, now), false);
  assert.equal(heldTierReleased(feedOf({ f2: 0 }), gate, now), false);
  assert.equal(heldTierReleased(feedOf({ f1: 0, f2: 1 }), gate, now), false);
});

test("Flight 1 and Flight 2 both sold out: Flight 3 released", () => {
  assert.equal(heldTierReleased(feedOf({ f1: 0, f2: 0 }), gate, now), true);
  assert.equal(heldTierReleased(feedOf({ f1: 0, f2: 0, regular: true }), gate, now), true);
  // Negative remaining (oversold) counts as none left.
  assert.equal(heldTierReleased(feedOf({ f1: -2, f2: 0 }), gate, now), true);
});

test("Regular tiers after 13 Nov count by id or by parent", () => {
  assert.equal(heldTierReleased(feedOf({ f1: 3, f2: 0, regular: true }), gate, now), false);
  assert.equal(groupSellableRemaining(feedOf({ f1: 7, regular: true }), gate.releaseWhenSoldOut[0], now), 7);
  const parentOnly = { results: [tt(538, null, F1, 4)] };
  assert.equal(groupSellableRemaining(parentOnly, gate.releaseWhenSoldOut[0], now), 4);
});

test("tiers not yet open, closed, or free never count as stock", () => {
  const feed = { results: [
    tt(539, 538, `${F1} · Early Bird`, 0),
    tt(547, 538, `${F1} · Regular`, 250, LATER, 35),
    tt(542, 541, `${F2} · Early Bird`, 0),
    tt(548, 541, `${F2} · Regular`, 250, [iso(now - 20 * DAY), iso(now - DAY)], 35),
    tt(9999, 541, "Kid free", 250, OPEN, 0),
  ] };
  assert.equal(heldTierReleased(feed, gate, now), true);
});

test("a flight missing from a live feed counts as sold out (inactive is not stock)", () => {
  const feed = { results: [tt(544, 543, `${F3} · Early Bird`, 250)] };
  assert.equal(heldTierReleased(feed, gate, now), true);
});

test("unknown stock keeps Flight 3 held", () => {
  assert.equal(heldTierReleased(null, gate, now), false);
  assert.equal(heldTierReleased(undefined, gate, now), false);
  assert.equal(heldTierReleased({}, gate, now), false);
  assert.equal(heldTierReleased({ results: [] }, gate, now), false);
  const hiddenQty = feedOf({ f1: 0, f2: 0 });
  hiddenQty.results[0].remaining_quantity = null;
  assert.equal(heldTierReleased(hiddenQty, gate, now), false);
  const textQty = feedOf({ f1: 0, f2: 0 });
  textQty.results[1].remaining_quantity = "0";
  assert.equal(heldTierReleased(textQty, gate, now), false);
});

test("hiding takes Flight 3 out of tickets and design rates only", () => {
  const payload = {
    tickets: [{ name: `${F1} · Early Bird` }, { name: `${F3} · Early Bird` }, { name: `${F2} · Early Bird` }],
    design: { ratesTitle: "Tickets", rates: [{ name: F1 }, { name: "Kid 12 and under" }, { name: F3 }, { name: `${F3} · Regular` }, { name: "flight 30 lounge" }] },
    addons: [{ name: "Flight 3 add-on" }],
  };
  const held = withHeldTiersHidden(payload, gate, false);
  assert.deepEqual(held.tickets.map((t) => t.name), [`${F1} · Early Bird`, `${F2} · Early Bird`]);
  assert.deepEqual(held.design.rates.map((r) => r.name), [F1, "Kid 12 and under", "flight 30 lounge"]);
  assert.equal(held.design.ratesTitle, "Tickets");
  assert.deepEqual(held.addons, payload.addons);
  assert.equal(payload.tickets.length, 3, "input untouched");
  assert.equal(withHeldTiersHidden(payload, gate, true), payload);
  assert.equal(withHeldTiersHidden(payload, null, false), payload);
});

// ----- the /api/event route -----

let feed8270 = feedOf();
const detail = { id: 8270, title: "Strange Bird Saturday", start_date: iso(now + 25 * DAY), end_date: iso(now + 25 * DAY + 7 * 3600e3), is_ticketed: true, is_perennial: false };
const other = { id: 7601, title: "Other", start_date: iso(now + 25 * DAY), end_date: iso(now + 26 * DAY), is_ticketed: true, is_perennial: false };
const otherFeed = { results: [tt(1, null, "Flight 3 · not gated here", 10)], addons: [] };

function kvWith(docs = {}) {
  const byKey = new Map(Object.entries(docs));
  return {
    async list({ prefix } = {}) { return { keys: [...byKey.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    async get(key, type) { if (!byKey.has(key)) return null; const v = byKey.get(key); return type === "json" ? JSON.parse(JSON.stringify(v)) : v; },
  };
}

async function withUpstream(fn, { feedDown = false, detailMissing = false } = {}) {
  forgetGuideStatuses();
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const calls = [];
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (input) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname;
    calls.push(path);
    if (path === "/api/events/details/8270/") return detailMissing ? new Response("{}", { status: 404 }) : Response.json(detail);
    if (path === "/api/events/details/7601/") return Response.json(other);
    if (path === "/api/ticket/purchase/tickets/8270/") return feedDown ? new Response("bad", { status: 502 }) : Response.json(feed8270);
    if (path === "/api/ticket/purchase/tickets/7601/") return Response.json(otherFeed);
    return new Response("", { status: 404 });
  };
  try { return await fn(calls); } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
}

async function get(id, docs = {}) {
  const res = await getEvent({
    request: new Request(`https://otratickets.com/api/event?id=${id}`),
    env: { OTRA_API_BASE: "https://otraguide.com/api", OVERRIDES: kvWith(docs) },
    waitUntil() {},
  });
  return { status: res.status, body: await res.json() };
}

const project = {
  id: "draft-sb-sat", otraGuideId: "8270", status: "published", createdAt: "2026-10-27T12:00:00.000Z",
  frozenSlug: "strange-bird-family-show-flight-3",
  claudeDesign: { rates: [{ name: F1 }, { name: `${F1} · Early Bird` }, { name: F2 }, { name: F3 }, { name: `${F3} · Early Bird` }, { name: `${F3} · Regular` }] },
};
const docs = { "site-event:draft-sb-sat": project };

test("route: F1 and F2 on sale, the page lists no Flight 3 rate or design rate", async () => {
  feed8270 = feedOf();
  await withUpstream(async (calls) => {
    const { status, body } = await get("8270", docs);
    assert.equal(status, 200);
    assert.deepEqual(body.tickets.map((t) => t.name), [`${F1} · Early Bird`, `${F2} · Early Bird`]);
    assert.ok(!body.design.rates.some((r) => /flight 3/i.test(r.name)));
    assert.equal(body.ticketSale.state, "on_sale");
    assert.equal(calls.filter((p) => p.startsWith("/api/ticket/purchase/tickets/")).length, 1, "stock read from the same feed");
  });
});

test("route: F1 sold out but F2 selling keeps Flight 3 off", async () => {
  feed8270 = feedOf({ f1: 0 });
  await withUpstream(async () => {
    const { body } = await get("8270", docs);
    assert.ok(!body.tickets.some((t) => /flight 3/i.test(t.name)));
  });
});

test("route: F1 and F2 sold out, Flight 3 appears automatically", async () => {
  feed8270 = feedOf({ f1: 0, f2: 0 });
  await withUpstream(async () => {
    const { body } = await get("8270", docs);
    assert.deepEqual(body.tickets.map((t) => t.name), [`${F1} · Early Bird`, `${F2} · Early Bird`, `${F3} · Early Bird`]);
    assert.equal(body.design.rates.filter((r) => /flight 3/i.test(r.name)).length, 3);
  });
});

test("route: Guide feed down keeps Flight 3 off (fail closed)", async () => {
  feed8270 = feedOf({ f1: 0, f2: 0 });
  await withUpstream(async () => {
    const { body } = await get("8270", docs);
    assert.ok(!body.design.rates.some((r) => /flight 3/i.test(r.name)));
  }, { feedDown: true });
});

test("route: the draft id URL and a checkout override onto 8270 are gated too", async () => {
  feed8270 = feedOf();
  await withUpstream(async () => {
    const { body } = await get("draft-sb-sat", docs);
    assert.equal(String(body.checkoutEventId), "8270");
    assert.ok(!body.tickets.some((t) => /flight 3/i.test(t.name)));
    const viaOverride = await get("7601", { "event:7601": { checkoutEventId: "8270" } });
    assert.equal(viaOverride.body.checkoutEventId, "8270");
    assert.deepEqual(viaOverride.body.tickets.map((t) => t.name), [`${F1} · Early Bird`, `${F2} · Early Bird`]);
  });
  feed8270 = feedOf({ f1: 0, f2: 0 });
  await withUpstream(async () => {
    const { body } = await get("draft-sb-sat", docs);
    assert.equal(body.tickets.filter((t) => /flight 3/i.test(t.name)).length, 3);
  });
});

test("route: other events are untouched and make no extra call", async () => {
  await withUpstream(async (calls) => {
    const { body } = await get("7601");
    assert.deepEqual(body.tickets.map((t) => t.name), ["Flight 3 · not gated here"]);
    assert.equal(calls.filter((p) => p.startsWith("/api/ticket/purchase/tickets/")).length, 1);
  });
});

test("route: no ids or stock leak into the public JSON", async () => {
  feed8270 = feedOf();
  await withUpstream(async () => {
    const { body } = await get("8270", docs);
    for (const t of body.tickets) {
      assert.deepEqual(Object.keys(t).sort(), ["currency", "description", "name", "price", "sale", "saleEndsAt", "saleStartsAt"]);
    }
  });
});
