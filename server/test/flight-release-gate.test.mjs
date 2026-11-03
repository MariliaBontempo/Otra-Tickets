import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as getEvent } from "../../functions/api/event.js";
import { forgetGuideStatuses } from "../../functions/_lib/guide-event-hidden.js";
import {
  FLIGHT_RELEASE_GATES, flightReleaseGate, heldTierReleased, withHeldTiersHidden,
} from "../../functions/_lib/flight-release-gate.js";

// Strange Bird Saturday (Guide 8270): Flight 3 stays off the page until Guide
// itself lists a Flight 3 tier in /api/ticket/purchase/tickets/8270/ (Calendar
// holds it there until Flights 1 and 2 sell out). Flight 1/2 remaining
// counts are never a release signal.
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const OPEN = [iso(now - 10 * DAY), iso(now + 10 * DAY)];

const tt = (id, parent, name, remaining, [start, end] = OPEN, price = 25) => ({
  id, name, price, event: 8270, description: "", base_currency: { code: "XCG" },
  sale_start_time: start, sale_end_time: end, parent_ticket_type: parent,
  remaining_quantity: remaining, hide_ticket_availability: true,
});
const F1 = "Flight 1 · 6:00–7:00 PM Family-Friendly";
const F2 = "Flight 2 · 7:30–8:30 PM Live Show";
const F3 = "Flight 3 · 9:00–10:00 PM Live Show";
// Live today: Guide lists only the F1 and F2 Early Birds. f3: true adds the
// Flight 3 tier the way Guide lists it once Calendar releases it.
const feedOf = ({ f1 = 250, f2 = 250, f3 = false, regular = false } = {}) => ({
  results: [
    ...(regular
      ? [tt(547, 538, `${F1} · Regular`, f1, OPEN, 35), tt(548, 541, `${F2} · Regular`, f2, OPEN, 35)]
      : [tt(539, 538, `${F1} · Early Bird`, f1), tt(542, 541, `${F2} · Early Bird`, f2)]),
    ...(f3 ? [regular ? tt(549, 543, `${F3} · Regular`, 250, OPEN, 35) : tt(544, 543, `${F3} · Early Bird`, 250)] : []),
  ],
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
  assert.equal(heldTierReleased(null, null), true, "no gate never holds anything");
});

test("live today: F1 and F2 on sale, no Flight 3 in the feed -> held", () => {
  assert.equal(heldTierReleased(feedOf(), gate), false);
});

test("F1 and F2 listed with remaining 0 but no Flight 3 in the feed -> still held (13 Nov pitfall)", () => {
  assert.equal(heldTierReleased(feedOf({ f1: 0, f2: 0 }), gate), false);
  assert.equal(heldTierReleased(feedOf({ f1: 0, f2: 0, regular: true }), gate), false);
  assert.equal(heldTierReleased(feedOf({ f1: -2, f2: 0 }), gate), false);
  // Parent sale window closed: remaining reads 0, nothing else listed.
  const closed = { results: [tt(539, 538, `${F1} · Early Bird`, 0, [iso(now - 20 * DAY), iso(now - 60e3)]), tt(542, 541, `${F2} · Early Bird`, 0, [iso(now - 20 * DAY), iso(now - 60e3)])] };
  assert.equal(heldTierReleased(closed, gate), false);
});

test("Flight 3 listed by Guide -> released, whatever F1/F2 stock says", () => {
  assert.equal(heldTierReleased(feedOf({ f1: 0, f2: 0, f3: true }), gate), true);
  assert.equal(heldTierReleased(feedOf({ f3: true }), gate), true, "Guide is the source of truth");
  assert.equal(heldTierReleased(feedOf({ f3: true, regular: true }), gate), true);
  assert.equal(heldTierReleased({ results: [tt(544, 543, `${F3} · Early Bird`, 250)] }, gate), true);
  // Parent row on its own, or a price sent as a decimal string.
  assert.equal(heldTierReleased({ results: [tt(543, null, F3, 250, OPEN, "25.00")] }, gate), true);
  // Matched by id when Guide renames the tier, or by name when ids change.
  assert.equal(heldTierReleased({ results: [tt(549, 543, "Late show · Regular", 10, OPEN, 35)] }, gate), true);
  assert.equal(heldTierReleased({ results: [tt(9001, 9000, "flight 3 · Early Bird", 10)] }, gate), true);
});

test("only a paid Flight 3 row releases; look alikes and junk do not", () => {
  assert.equal(heldTierReleased({ results: [tt(9999, 541, `${F3} kid`, 10, OPEN, 0)] }, gate), false, "free");
  assert.equal(heldTierReleased({ results: [tt(544, 543, F3, 10, OPEN, "abc")] }, gate), false, "bad price");
  const noPrice = { results: [tt(544, 543, F3, 10)] };
  delete noPrice.results[0].price;
  assert.equal(heldTierReleased(noPrice, gate), false, "no price");
  assert.equal(heldTierReleased({ results: [tt(9001, 9000, "Flight 30 lounge", 10)] }, gate), false, "flight 30");
  assert.equal(heldTierReleased({ results: [null, "Flight 3", 3] }, gate), false, "junk rows");
  const elsewhere = { results: [{ ...tt(544, 543, F3, 10), event: 7601 }] };
  assert.equal(heldTierReleased(elsewhere, gate), false, "row of another event");
  // Junk rows are skipped and do not block a real Flight 3 row.
  const mixed = feedOf({ f3: true });
  mixed.results.unshift(null);
  assert.equal(heldTierReleased(mixed, gate), true);
});

test("unknown or empty feed keeps Flight 3 held (fail closed)", () => {
  assert.equal(heldTierReleased(null, gate), false);
  assert.equal(heldTierReleased(undefined, gate), false);
  assert.equal(heldTierReleased({}, gate), false);
  assert.equal(heldTierReleased({ results: [] }, gate), false);
  assert.equal(heldTierReleased({ results: "Flight 3" }, gate), false);
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

test("route: F1 and F2 at remaining 0 with no Flight 3 in the feed keeps Flight 3 off", async () => {
  feed8270 = feedOf({ f1: 0, f2: 0 });
  await withUpstream(async () => {
    const { body } = await get("8270", docs);
    assert.ok(!body.tickets.some((t) => /flight 3/i.test(t.name)));
  });
});

test("route: Guide lists Flight 3, Flight 3 appears automatically", async () => {
  feed8270 = feedOf({ f1: 0, f2: 0, f3: true });
  await withUpstream(async () => {
    const { body } = await get("8270", docs);
    assert.deepEqual(body.tickets.map((t) => t.name), [`${F1} · Early Bird`, `${F2} · Early Bird`, `${F3} · Early Bird`]);
    assert.equal(body.design.rates.filter((r) => /flight 3/i.test(r.name)).length, 3);
  });
});

test("route: Guide feed down keeps Flight 3 off (fail closed)", async () => {
  feed8270 = feedOf({ f1: 0, f2: 0, f3: true });
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
  feed8270 = feedOf({ f1: 0, f2: 0, f3: true });
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
