import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as eventRoute } from "../../functions/api/event.js";
import { onRequestGet as overrideRoute } from "../../functions/api/override.js";
import { onRequestGet as slugRoute } from "../../functions/[slug].js";
import { onRequestPost as projectsPost } from "../../functions/admin/api/projects.js";
import { onRequestGet as pagesGet } from "../../functions/admin/api/pages.js";
import { rewriteProjectDate } from "../../functions/admin/api/events.js";
import { dropUnlistedIndex, getPublicHomepageFeed, invalidatePublicFeed } from "../../functions/_lib/homepage-feed.js";
import {
  HIDDEN_DETAIL_EXCEPTIONS, KEEP_SELLING_FLAG, forgetGuideStatuses, isHiddenGuideEvent,
  keepsSellingFlagOn, keepsSellingWhileHidden,
} from "../../functions/_lib/guide-event-hidden.js";

const API = "https://guide.test/api";
const rates = { rates: [{ name: "Flight Ticket", price: "25.00", currency: "USD" }] };
const EVENT_HTML = '<!doctype html><html><head><title>Event</title><script src="/site-overrides.js"></script></head><body data-event-id=""></body></html>';

function sat(n, extra = {}) {
  return {
    id: `draft-sat-${n}`, otraGuideId: String(9267 + n), otraGuideSlug: String(9267 + n),
    title: `Strange Bird Family Show Flight ${n}`, status: "published",
    publishedAt: "2026-10-27T12:00:00.000Z", createdAt: `2026-10-27T1${n}:00:00.000Z`,
    frozenSlug: `strange-bird-family-show-flight-${n}`, unlisted: true,
    startDate: "2999-10-31T10:00:00-04:00", claudeDesign: rates, ...extra,
  };
}

function makeKv(projects) {
  const store = new Map(projects.map((p) => [`site-event:${p.id}`, p]));
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      if (type === "json") return JSON.parse(JSON.stringify(value));
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async put(key, value) { store.set(key, typeof value === "string" ? JSON.parse(value) : value); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    store,
  };
}

// Guide: every detail 404 (private / staff only), feeds live unless listed in emptyFeeds.
function installFetch({ emptyFeeds = new Set(), failFeeds = new Set() } = {}) {
  const real = globalThis.fetch;
  const realCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (input) => {
    const url = String(input && input.url ? input.url : input);
    const ok = (body) => Response.json(body);
    if (url.endsWith("/users/user-role/")) return ok({ is_staff_or_admin: true });
    const detail = url.match(/\/events\/details\/(\d+)\//);
    if (detail) return new Response("{}", { status: 404 });
    const tickets = url.match(/\/ticket\/purchase\/tickets\/(\d+)\//);
    if (tickets && failFeeds.has(tickets[1])) throw new Error("ticket feed down");
    if (tickets) return ok(emptyFeeds.has(tickets[1]) ? { results: [] } : { results: [{ id: 1, name: "Flight Ticket", price: "25.00" }] });
    if (/stripe-external-iframe/.test(url)) return new Response("", { status: 200 });
    return ok({ results: [] });
  };
  return () => { globalThis.fetch = real; globalThis.caches = realCaches; };
}

function ctx(kv, path, extra = {}) {
  return {
    env: { OVERRIDES: kv, OTRA_API_URL: API, ASSETS: { async fetch() { return new Response(EVENT_HTML, { headers: { "content-type": "text/html" } }); } } },
    request: new Request("https://otratickets.com" + path, extra.init),
    waitUntil() {},
    ...extra,
  };
}

async function fresh(kv) {
  forgetGuideStatuses();
  dropUnlistedIndex(kv);
  await invalidatePublicFeed(kv);
}

const event = (kv, id) => eventRoute(ctx(kv, `/api/event?id=${id}`));
const pretty = (kv, slug) => slugRoute({ ...ctx(kv, "/" + slug), getHomepageEvents: async () => ({ events: [] }), params: { slug } });

test("switch on: Guide private + live feed serves /api/event, draft id, override and the pretty URL", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true })]);
    await fresh(kv);
    const byGuide = await event(kv, "9268");
    assert.equal(byGuide.status, 200);
    const body = await byGuide.json();
    assert.equal(body.id, 9268);
    assert.equal(body.unlisted, true);
    assert.equal((await event(kv, "draft-sat-1")).status, 200);
    assert.equal(await isHiddenGuideEvent({ OVERRIDES: kv, OTRA_API_URL: API }, "9268", "draft-sat-1"), false);
    const page = await pretty(kv, "strange-bird-family-show-flight-1");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("x-robots-tag") || "", /noindex/);
    await kv.put("event:9268", JSON.stringify({ description: "hi", pageEditsVersion: 2, updatedAt: "2026-10-27T00:00:00Z" }));
    const ov = await (await overrideRoute(ctx(kv, "/api/override?id=9268"))).json();
    assert.equal(ov.override && ov.override.description, "hi", "page edits served");
  } finally { restore(); }
});

test("Unlisted alone (switch off) keeps the page hidden everywhere", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([sat(2)]);
    await fresh(kv);
    assert.equal((await event(kv, "9269")).status, 404);
    assert.equal((await event(kv, "draft-sat-2")).status, 404);
    assert.equal(await isHiddenGuideEvent({ OVERRIDES: kv, OTRA_API_URL: API }, "9269", "draft-sat-2"), true);
    assert.equal((await pretty(kv, "strange-bird-family-show-flight-2")).status, 404);
    await kv.put("event:9269", JSON.stringify({ description: "hi", pageEditsVersion: 2, updatedAt: "2026-10-27T00:00:00Z" }));
    const ov = await (await overrideRoute(ctx(kv, "/api/override?id=9269"))).json();
    assert.equal(ov.override, null, "page edits hidden");
  } finally { restore(); }
});

test("switch on fails closed: empty feed, admin only, unpublished, archived, other Guide id", async () => {
  const restore = installFetch({ emptyFeeds: new Set(["9270"]) });
  try {
    const kv = makeKv([sat(3, { [KEEP_SELLING_FLAG]: true })]);
    await fresh(kv);
    assert.equal((await event(kv, "9270")).status, 404, "empty feed hides");
    assert.equal((await pretty(kv, "strange-bird-family-show-flight-3")).status, 404);

    const admin = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true, adminOnly: true })]);
    await fresh(admin);
    assert.equal((await event(admin, "9268")).status, 404, "admin only stays 404 to the public");

    const draft = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true, status: "draft" })]);
    await fresh(draft);
    assert.equal((await event(draft, "9268")).status, 404, "unpublished stays hidden");

    const p = sat(1, { [KEEP_SELLING_FLAG]: true });
    assert.equal(keepsSellingFlagOn(p, "9268", "draft-sat-1"), true);
    assert.equal(keepsSellingFlagOn(p, "9269", "draft-sat-1"), false, "other Guide id");
    assert.equal(keepsSellingFlagOn(p, "9268", "draft-other"), false, "other project");
    assert.equal(keepsSellingFlagOn({ ...p, archivedAt: "2026-10-27" }, "9268", "draft-sat-1"), false);
    assert.equal(keepsSellingFlagOn({ ...p, [KEEP_SELLING_FLAG]: "true" }, "9268", "draft-sat-1"), false, "only boolean true");
    assert.equal(keepsSellingFlagOn(null, "9268", "draft-sat-1"), false);
    assert.equal(await keepsSellingWhileHidden(API, "9268", "draft-missing", undefined, { kv }), false, "missing project");
    assert.equal(await keepsSellingWhileHidden(API, "9268", "", undefined, { project: p }), false, "no project id");
  } finally { restore(); }
});

test("legacy exceptions keep working without the switch and the list does not grow", async () => {
  const restore = installFetch();
  try {
    assert.deepEqual(Object.keys(HIDDEN_DETAIL_EXCEPTIONS).sort(), ["8088", "8266", "8267"]);
    const legacy = {
      id: HIDDEN_DETAIL_EXCEPTIONS["8267"], otraGuideId: "8267", otraGuideSlug: "8267", title: "Dress Up Evening",
      status: "published", publishedAt: "2026-10-20T12:00:00.000Z", createdAt: "2026-10-20T10:00:00.000Z",
      frozenSlug: "strange-bird-dress-up-evening", unlisted: true, startDate: "2999-10-30T19:00:00-04:00", claudeDesign: rates,
    };
    const kv = makeKv([legacy]);
    await fresh(kv);
    assert.equal((await event(kv, "8267")).status, 200);
    assert.equal((await pretty(kv, "strange-bird-dress-up-evening")).status, 200);
  } finally { restore(); }
});

test("admin switch persists, shows in the page list, survives other toggles, and refuses unbound drafts", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([sat(1), { id: "draft-unbound", title: "Unbound", status: "draft", createdAt: "2026-10-27T09:00:00.000Z" }]);
    await fresh(kv);
    const post = async (query) => {
      const r = await projectsPost(ctx(kv, "/admin/api/projects?" + query, { init: { method: "POST", headers: { authorization: "Bearer t" } } }));
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await event(kv, "9268")).status, 404, "off before the switch");
    const on = await post("action=set-keep-selling-while-guide-private&id=draft-sat-1&value=true");
    assert.equal(on.status, 200);
    assert.equal(on.body.project[KEEP_SELLING_FLAG], true);
    assert.equal(kv.store.get("site-event:draft-sat-1")[KEEP_SELLING_FLAG], true);
    await fresh(kv);
    assert.equal((await event(kv, "9268")).status, 200, "on after the switch");
    const relink = await post("action=set-unlisted&id=draft-sat-1&value=true");
    assert.equal(relink.status, 200);
    assert.equal(kv.store.get("site-event:draft-sat-1")[KEEP_SELLING_FLAG], true, "another toggle keeps the switch");
    assert.equal((await post("action=set-admin-only&id=draft-sat-1&value=false")).status, 200);
    assert.equal(kv.store.get("site-event:draft-sat-1")[KEEP_SELLING_FLAG], true, "admin-only toggle keeps the switch");
    assert.equal(rewriteProjectDate(kv.store.get("site-event:draft-sat-1"), "2999-11-01T10:00:00-04:00", "")[KEEP_SELLING_FLAG], true, "date move keeps the switch");
    const pages = await (await pagesGet(ctx(kv, "/admin/api/pages", { init: { headers: { authorization: "Bearer t" } } }))).json();
    const row = (pages.pages || []).find((p) => p.projectId === "draft-sat-1" || p.id === "draft-sat-1");
    assert.equal(row && row[KEEP_SELLING_FLAG], true, "page list carries the switch");
    const off = await post("action=set-keep-selling-while-guide-private&id=draft-sat-1&value=false");
    assert.equal(off.body.project[KEEP_SELLING_FLAG], false);
    await fresh(kv);
    assert.equal((await event(kv, "9268")).status, 404, "off again hides");
    const unbound = await post("action=set-keep-selling-while-guide-private&id=draft-unbound&value=true");
    assert.equal(unbound.status, 409);
    assert.equal(unbound.body.project, undefined, "409 does not echo the page");
    assert.notEqual(kv.store.get("site-event:draft-unbound")[KEEP_SELLING_FLAG], true, "409 changes nothing");
    assert.equal((await post("action=set-keep-selling-while-guide-private&id=bad&value=true")).status, 400);
    assert.equal((await post("action=set-keep-selling-while-guide-private&id=draft-nope&value=true")).status, 404);
    // Strict value: anything but true/false is refused and changes nothing.
    await post("action=set-keep-selling-while-guide-private&id=draft-sat-1&value=true");
    assert.equal((await post("action=set-keep-selling-while-guide-private&id=draft-sat-1&value=yes")).status, 400);
    assert.equal((await post("action=set-keep-selling-while-guide-private&id=draft-sat-1")).status, 400);
    assert.equal(kv.store.get("site-event:draft-sat-1")[KEEP_SELLING_FLAG], true, "bad value leaves the switch as it was");
    // Every change is in the page's audit log.
    const audit = kv.store.get("audit:event:draft-sat-1");
    const fields = (Array.isArray(audit) ? audit : []).flatMap((e) => e.changedFields || []);
    assert.ok(fields.includes("keepSellingWhileGuidePrivate:true") && fields.includes("keepSellingWhileGuidePrivate:false"), "audited");
  } finally { restore(); }
});

test("switch changes apply on the next request, the draft-id override follows it, and listing stays Unlisted's job", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true }), sat(2, { [KEEP_SELLING_FLAG]: true, unlisted: false })]);
    await fresh(kv);
    const post = (query) => projectsPost(ctx(kv, "/admin/api/projects?" + query, { init: { method: "POST", headers: { authorization: "Bearer t" } } }));
    await kv.put("override:draft-sat-1", JSON.stringify({ description: "draft edits", pageEditsVersion: 2, updatedAt: "2026-10-27T00:00:00Z" }));
    assert.equal((await pretty(kv, "strange-bird-family-show-flight-1")).status, 200);
    const draftOv = await (await overrideRoute(ctx(kv, "/api/override?id=draft-sat-1"))).json();
    assert.equal(draftOv.override && draftOv.override.description, "draft edits");

    // The switch never changes listing: Unlisted keeps a page off the homepage.
    const feed = await getPublicHomepageFeed(ctx(kv, "/api/homepage-events"));
    const ids = JSON.stringify(feed);
    assert.doesNotMatch(ids, /strange-bird-family-show-flight-1|draft-sat-1|"9268"/, "unlisted page stays off the homepage");
    // Listing is still Unlisted's job: a listed page with the switch shows like any listed page.
    assert.ok((feed.events || []).some((e) => String(e.id) === "9269"), "listed page with the switch is listed");

    assert.equal((await post("action=set-keep-selling-while-guide-private&id=draft-sat-1&value=false")).status, 200);
    // No cache reset: the very next request follows the switch.
    assert.equal((await event(kv, "9268")).status, 404);
    assert.equal((await pretty(kv, "strange-bird-family-show-flight-1")).status, 404);
    assert.equal((await (await overrideRoute(ctx(kv, "/api/override?id=draft-sat-1"))).json()).override, null);
    assert.equal((await post("action=set-keep-selling-while-guide-private&id=draft-sat-1&value=true")).status, 200);
    assert.equal((await event(kv, "9268")).status, 200);
    assert.equal((await pretty(kv, "strange-bird-family-show-flight-1")).status, 200);
  } finally { restore(); }
});

test("non-staff cannot set the switch", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  try {
    const kv = makeKv([sat(1)]);
    const r = await projectsPost(ctx(kv, "/admin/api/projects?action=set-keep-selling-while-guide-private&id=draft-sat-1&value=true", { init: { method: "POST", headers: { authorization: "Bearer nope" } } }));
    assert.equal(r.status, 401);
    assert.notEqual(kv.store.get("site-event:draft-sat-1")[KEEP_SELLING_FLAG], true);
    const anon = await projectsPost(ctx(kv, "/admin/api/projects?action=set-keep-selling-while-guide-private&id=draft-sat-1&value=true", { init: { method: "POST" } }));
    assert.equal(anon.status, 401);
  } finally { globalThis.fetch = real; }
});

test("an ended page on the switch stops offering checkout on its Guide-id URL; legacy pages keep ignoring their dates", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true, startDate: "2020-01-10T10:00:00-04:00", endDate: "2020-01-10T12:00:00-04:00" })]);
    await fresh(kv);
    const byGuide = await event(kv, "9268");
    assert.equal(byGuide.status, 200);
    assert.equal((await byGuide.json()).isPast, true, "Guide-id URL knows it ended");
    assert.equal((await (await event(kv, "draft-sat-1")).json()).isPast, true, "same as the draft-id URL");
    const upcoming = makeKv([sat(2, { [KEEP_SELLING_FLAG]: true })]);
    await fresh(upcoming);
    assert.equal((await (await event(upcoming, "9269")).json()).isPast, false, "upcoming page still sells");

    const legacy = makeKv([{
      id: HIDDEN_DETAIL_EXCEPTIONS["8088"], otraGuideId: "8088", otraGuideSlug: "8088", title: "Practical", status: "published",
      publishedAt: "2026-01-01T12:00:00.000Z", createdAt: "2026-01-01T10:00:00.000Z", startDate: "2020-01-10T10:00:00-04:00",
      endDate: "2020-01-10T12:00:00-04:00", claudeDesign: rates,
    }]);
    await fresh(legacy);
    const old = await event(legacy, "8088");
    assert.equal(old.status, 200);
    assert.equal((await old.json()).isPast, false, "legacy 8088 keeps selling while its feed is live, as before");
  } finally { restore(); }
});

test("a newer unpublished draft on the same Guide event does not switch the live page off", async () => {
  const restore = installFetch();
  try {
    const newer = {
      id: "draft-sat-1-next", otraGuideId: "9268", otraGuideSlug: "9268", title: "Next edition (draft)", status: "draft",
      createdAt: "2026-10-28T10:00:00.000Z", claudeDesign: rates, [KEEP_SELLING_FLAG]: true,
    };
    const kv = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true }), newer]);
    await fresh(kv);
    const r = await event(kv, "9268");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, "published", "the live page shapes the response, not the newer draft");
    assert.equal(body.isDraft, false);
    assert.equal(body.title, "Strange Bird Family Show Flight 1");
    assert.equal((await event(kv, "draft-sat-1-next")).status, 404, "the unpublished draft itself stays hidden");

    // Switch off on the live page: hidden, even though the newer draft has it on.
    const off = makeKv([sat(1), newer]);
    await fresh(off);
    assert.equal((await event(off, "9268")).status, 404);
  } finally { restore(); }
});

test("legacy 8088 and 8266 still serve by Guide id with no switch", async () => {
  const restore = installFetch();
  try {
    for (const guideId of ["8088", "8266"]) {
      const kv = makeKv([{
        id: HIDDEN_DETAIL_EXCEPTIONS[guideId], otraGuideId: guideId, otraGuideSlug: guideId, title: `Legacy ${guideId}`,
        status: "published", publishedAt: "2026-10-01T12:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z",
        startDate: "2999-10-30T19:00:00-04:00", claudeDesign: rates,
      }]);
      await fresh(kv);
      assert.equal((await event(kv, guideId)).status, 200, `legacy ${guideId}`);
      assert.equal(await isHiddenGuideEvent({ OVERRIDES: kv, OTRA_API_URL: API }, guideId, HIDDEN_DETAIL_EXCEPTIONS[guideId]), false);
    }
  } finally { restore(); }
});

test("a KV error fails closed, and a record handed in by the caller is used as is", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true })]);
    await fresh(kv);
    const broken = { ...kv, async get() { throw new Error("kv down"); } };
    assert.equal(await keepsSellingWhileHidden(API, "9268", "draft-sat-1", undefined, { kv: broken }), false);
    assert.equal(await isHiddenGuideEvent({ OVERRIDES: broken, OTRA_API_URL: API }, "9268", "draft-sat-1"), true, "KV error hides");
    const record = sat(1, { [KEEP_SELLING_FLAG]: true });
    delete record.id;
    assert.equal(await isHiddenGuideEvent({ OVERRIDES: broken, OTRA_API_URL: API }, "9268", "draft-sat-1", record), false, "uses the record it was given");
    assert.equal(await isHiddenGuideEvent({ OVERRIDES: broken, OTRA_API_URL: API }, "9268", "draft-sat-1", sat(1)), true, "given record with the switch off hides");
  } finally { restore(); }
});

test("homepage: a listed page on a private Guide event shows only with the switch on", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([sat(1, { unlisted: false }), sat(2, { unlisted: false, [KEEP_SELLING_FLAG]: true }), sat(3, { [KEEP_SELLING_FLAG]: true })]);
    await fresh(kv);
    const feed = await getPublicHomepageFeed(ctx(kv, "/api/homepage-events"));
    const ids = (feed.events || []).map((e) => String(e.id));
    assert.ok(!ids.includes("9268"), "listed, switch off: hidden like any private Guide event");
    assert.ok(ids.includes("9269"), "listed, switch on: listed");
    assert.ok(!ids.includes("9270"), "unlisted, switch on: link only");
  } finally { restore(); }
});

test("a failing ticket feed hides the page, and an empty feed hides the draft-id URL too", async () => {
  let restore = installFetch({ failFeeds: new Set(["9268"]) });
  try {
    const kv = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true })]);
    await fresh(kv);
    assert.equal((await event(kv, "9268")).status, 404, "feed error: Guide-id URL hidden");
    assert.equal((await event(kv, "draft-sat-1")).status, 404, "feed error: draft-id URL hidden");
  } finally { restore(); }
  restore = installFetch({ emptyFeeds: new Set(["9268"]) });
  try {
    const kv = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true })]);
    await fresh(kv);
    assert.equal((await event(kv, "draft-sat-1")).status, 404, "empty feed: draft-id URL hidden");
  } finally { restore(); }
});

test("a stored switch that is not exactly true is off, and saving the page writes it as false", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([sat(1, { [KEEP_SELLING_FLAG]: "true" })]);
    await fresh(kv);
    assert.equal((await event(kv, "9268")).status, 404, "string 'true' is not on");
    const r = await projectsPost(ctx(kv, "/admin/api/projects?action=set-unlisted&id=draft-sat-1&value=true", { init: { method: "POST", headers: { authorization: "Bearer t" } } }));
    assert.equal(r.status, 200);
    assert.equal(kv.store.get("site-event:draft-sat-1")[KEEP_SELLING_FLAG], false);
  } finally { restore(); }
});

test("legacy page with a newer unpublished draft on the same Guide id keeps serving the live page", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([
      { id: HIDDEN_DETAIL_EXCEPTIONS["8267"], otraGuideId: "8267", otraGuideSlug: "8267", title: "Dress Up Evening", status: "published",
        publishedAt: "2026-10-01T12:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z", startDate: "2999-10-30T19:00:00-04:00", claudeDesign: rates },
      { id: "draft-legacy-next", otraGuideId: "8267", otraGuideSlug: "8267", title: "Next (draft)", status: "draft",
        createdAt: "2026-10-28T10:00:00.000Z", claudeDesign: rates },
    ]);
    await fresh(kv);
    const r = await event(kv, "8267");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).title, "Dress Up Evening");
  } finally { restore(); }
});

test("admin page list carries admin only on live Guide-id rows", async () => {
  const restore = installFetch();
  try {
    const kv = makeKv([sat(1, { [KEEP_SELLING_FLAG]: true, adminOnly: true }), sat(2, { [KEEP_SELLING_FLAG]: true })]);
    await fresh(kv);
    const pages = await (await pagesGet(ctx(kv, "/admin/api/pages", { init: { headers: { authorization: "Bearer t" } } }))).json();
    const rows = pages.pages || [];
    const one = rows.find((p) => p.projectId === "draft-sat-1" || p.id === "draft-sat-1");
    const two = rows.find((p) => p.projectId === "draft-sat-2" || p.id === "draft-sat-2");
    assert.equal(one && one.adminOnly, true);
    assert.equal(two && two.adminOnly, false);
    assert.equal((await event(kv, "9268")).status, 404, "admin only page on the switch stays hidden");
  } finally { restore(); }
});
