import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet } from "../../functions/api/event.js";

const ENV = { OTRA_API_URL: "https://guide.test/api" };
const ADDON = {
  id: 110, title: "Lounge Package", description: "Table for six", price: 25.0,
  base_currency: "USD", currency_symbol: "$", max_per_order: 10, quantity_remaining: null,
  has_fee: true, fee_amount: 1.38, total_with_fee: 26.38, image_url: "x",
};

function setup({ staffToken = "staff-jwt", withAddons = true } = {}) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const calls = [];
  const puts = [];
  globalThis.caches = { default: { async match() { return null; }, async put(...a) { puts.push(a); } } };
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(input);
    const auth = (init.headers && (init.headers.authorization || init.headers.Authorization)) || null;
    calls.push({ path: u.pathname, search: u.search, auth, cf: init.cf });
    if (u.pathname === "/api/users/user-role/") {
      return auth === `Bearer ${staffToken}` ? Response.json({ is_staff_or_admin: true }) : Response.json({ is_staff_or_admin: false });
    }
    if (u.pathname === "/api/events/details/8257/") {
      return auth === `Bearer ${staffToken}`
        ? Response.json({ id: 8257, title: "Cascada NYE", is_ticketed: true })
        : new Response(null, { status: 404 });
    }
    if (u.pathname === "/api/events/details/9000/") return Response.json({ id: 9000, title: "Public Event", is_ticketed: true });
    if (/^\/api\/ticket\/purchase\/tickets\/(8257|9000)\/$/.test(u.pathname)) {
      return Response.json({
        results: [{ id: 1, name: "VIP", price: "350.00", base_currency: { code: "USD" } }],
        ...(withAddons ? { addons: [ADDON] } : {}),
      });
    }
    if (u.pathname.startsWith("/ticketing/")) return new Response("", { status: 200 });
    throw new Error(`Unexpected request: ${u.pathname}`);
  };
  const restore = () => { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; };
  return { calls, puts, restore };
}

const get = (id, cookie) =>
  onRequestGet({
    request: new Request(`https://tickets.test/api/event?id=${id}`, cookie ? { headers: { cookie } } : {}),
    env: ENV,
    waitUntil() {},
  });

test("staff cookie opens a staff-only Guide event, uncached, with add-ons", async () => {
  const { calls, puts, restore } = setup();
  try {
    const res = await get(8257, "otra_session=staff-jwt");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.id, 8257);
    assert.equal(body.staffView, undefined);
    assert.equal(body.staffPreview, true);
    assert.deepEqual(body.addons, [{ name: "Lounge Package", description: "Table for six", price: 25, currency: "USD" }]);
    assert.equal(puts.length, 0);
    const authed = calls.filter(c => c.auth === "Bearer staff-jwt" && c.path !== "/api/users/user-role/");
    assert.ok(authed.some(c => c.path === "/api/events/details/8257/" && !c.cf));
    assert.ok(authed.some(c => c.path === "/api/ticket/purchase/tickets/8257/" && !c.cf));
    assert.equal(calls.filter(c => c.path === "/api/users/user-role/").length, 1);
  } finally { restore(); }
});

test("anonymous callers get 404 for a staff-only Guide event", async () => {
  const { restore } = setup();
  try { assert.equal((await get(8257)).status, 404); } finally { restore(); }
});

test("a non-staff cookie gets 404 for a staff-only Guide event", async () => {
  const { restore } = setup();
  try { assert.equal((await get(8257, "otra_session=regular-jwt")).status, 404); } finally { restore(); }
});

test("public events include mapped add-ons, request choice add-ons, and are still cached", async () => {
  const { calls, puts, restore } = setup();
  try {
    const res = await get(9000);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.addons, [{ name: "Lounge Package", description: "Table for six", price: 25, currency: "USD" }]);
    assert.equal(puts.length, 1);
    // The server side base cache keeps its 10 minute TTL while the browser
    // answer revalidates on every load.
    assert.equal(puts[0][1].headers.get("cache-control"), "public, max-age=600");
    assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal(body.staffPreview, undefined);
    assert.ok(calls.some(c => c.path === "/api/ticket/purchase/tickets/9000/" && c.search === "?include_choice_addons=1"));
  } finally { restore(); }
});

test("addons is an empty list when the feed has none", async () => {
  const { restore } = setup({ withAddons: false });
  try { assert.deepEqual((await (await get(9000)).json()).addons, []); } finally { restore(); }
});

test("staff get the same 8088 published-design fallback as the public, and Bearer header works for staff-only events", async () => {
  const { restore } = setup();
  const project = {
    id: "draft-1791253678425-26c548a5", otraGuideId: "8088", status: "published", adminOnly: false,
    title: "Finish Line Party", frozenSlug: "finish-line-party",
    claudeDesign: { rates: [{ name: "Finish Line Ticket", price: "20.00", currency: "USD" }] },
  };
  const kv = {
    async list() { return { keys: [{ name: `site-event:${project.id}` }], list_complete: true }; },
    async get(key) { return key === `site-event:${project.id}` ? project : null; },
  };
  const inner = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(input);
    calls.push(u.pathname);
    if (u.pathname === "/api/events/details/8088/") {
      const auth = init.headers && init.headers.authorization;
      return auth ? Response.json({ id: 8088, title: "Guide 8088" }) : new Response(null, { status: 404 });
    }
    if (u.pathname === "/api/ticket/purchase/tickets/8088/") return Response.json({ results: [{ id: 491 }] });
    return inner(input, init);
  };
  const env = { ...ENV, OVERRIDES: kv };
  const req = headers => new Request("https://tickets.test/api/event?id=8088", { headers });
  try {
    const anon = await (await onRequestGet({ request: req({}), env, waitUntil() {} })).json();
    const staffRes = await onRequestGet({ request: req({ cookie: "otra_session=staff-jwt" }), env, waitUntil() {} });
    const staff = await staffRes.json();
    assert.deepEqual(staff, anon);
    assert.equal(anon.title, "Finish Line Party");
    assert.equal(staffRes.headers.get("cache-control"), "public, max-age=0, must-revalidate");

    const bearer = await onRequestGet({
      request: new Request("https://tickets.test/api/event?id=8257", { headers: { authorization: "Bearer staff-jwt" } }),
      env: ENV, waitUntil() {},
    });
    assert.equal(bearer.status, 200);
    assert.equal((await bearer.json()).id, 8257);
  } finally { restore(); }
});
