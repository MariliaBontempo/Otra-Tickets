#!/usr/bin/env node
// Oracle: unlisted (link only) pages. Off the homepage feed, search, sitemap
// and llms.txt; still open (and sell) at their short /<slug> link with
// noindex; a listed page always wins its slug; the event page never moves to
// a short link that would not open; the admin toggle, Copy link and Edit link
// are wired; links stay short and plain (no draft ids, no hashes).
// Run: node scripts/check-unlisted-link-only.mjs

import { readFileSync } from "node:fs";
import { buildHomepageFeed, buildPublishedSiteEvents, dropUnlistedIndex, findUnlistedSiteEvent } from "../functions/_lib/homepage-feed.js";
import { cleanUnlistedSlug, defaultUnlistedSlug, pickUnlistedSlug, UNLISTED_SLUG_MAX } from "../functions/_lib/unlisted.js";
import { onRequestGet as slugRoute } from "../functions/[slug].js";
import { onRequestGet as sitemapRoute } from "../functions/sitemap.xml.js";
import { onRequestGet as llmsRoute } from "../functions/llms.txt.js";
import { onRequestGet as homepageEventsRoute } from "../functions/api/homepage-events.js";
import { onRequestGet as eventRoute } from "../functions/api/event.js";
import { onRequestPost as projectsPost } from "../functions/admin/api/projects.js";
import { onRequestGet as pagesGet } from "../functions/admin/api/pages.js";

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };
const SNAP_KEY = "__homepage_feed_snapshot__";
const API = "https://og.test/api";
const rates = { rates: [{ name: "General Admission", price: "25.00" }] };

// ── 1. Link rules: short, plain, never an id or a hash ──
{
  const long = cleanUnlistedSlug("Strange Bird Gala Secret Night With A Very Long Title That Keeps Going And Going Forever");
  assert(long.length <= UNLISTED_SLUG_MAX, "a long title must give a link of at most 60 characters");
  assert(!long.endsWith("-") && "strange-bird-gala-secret-night-with-a-very-long-title-that-keeps".startsWith(long), "a long link is cut on a word boundary: " + long);
  assert(cleanUnlistedSlug("Strange Bird Gala (secret)!") === "strange-bird-gala-secret", "titles become plain dashed links");
  const taken = new Map([["strange-bird-gala", "Strange Bird Gala"]]);
  const auto = pickUnlistedSlug({ fallback: "strange-bird-gala", taken });
  assert(auto.slug === "strange-bird-gala-2", "a taken default link gets a plain counter, got " + JSON.stringify(auto));
  const explicit = pickUnlistedSlug({ requested: "strange-bird-gala", fallback: "x", taken });
  assert(explicit.status === 409 && /already used by "Strange Bird Gala"/.test(explicit.error), "a taken link typed by hand is refused with the page using it");
  assert(pickUnlistedSlug({ requested: "admin", taken }).status === 400, "site paths (admin) are refused");
  assert(pickUnlistedSlug({ requested: "iguana-ride-e-scooter-night-tour", taken }).status === 400, "slug aliases are refused");
  assert(pickUnlistedSlug({ requested: "12345", taken }).status === 400, "a numbers only link is refused");
  assert(pickUnlistedSlug({ requested: "/Strange Bird Secret/", taken }).slug === "strange-bird-secret", "a typed link is cleaned");
  const fromDraft = defaultUnlistedSlug({ id: "draft-1777000000000-ab12cd34", title: "Strange Bird Gala (clone)", status: "draft" });
  assert(fromDraft === "strange-bird-gala", "a draft link comes from its title, clone stripped, never the draft id: " + fromDraft);
  assert(defaultUnlistedSlug({ title: "Renamed", status: "published", frozenSlug: "strange-bird-gala-secret" }) === "strange-bird-gala-secret", "a published page keeps its frozen link");
}

// ── Fixtures ──
function baseProjects() {
  return {
    "site-event:draft-public": {
      id: "draft-public", otraGuideId: "7999", otraGuideSlug: "7999", title: "Listed Party", status: "published",
      publishedAt: "2026-10-01T12:00:00.000Z", frozenSlug: "listed-party",
      startDate: "2999-01-01T20:00:00-04:00", endDate: "2999-01-02T02:00:00-04:00", claudeDesign: rates,
      createdAt: "2026-10-01T10:00:00.000Z",
    },
    "site-event:draft-secret": {
      id: "draft-secret", otraGuideId: "7600", otraGuideSlug: "7600", title: "Strange Bird Gala Secret", status: "published",
      publishedAt: "2026-10-02T12:00:00.000Z", frozenSlug: "strange-bird-gala-secret", unlisted: true,
      startDate: "2999-02-01T20:00:00-04:00", endDate: "2999-02-02T02:00:00-04:00", claudeDesign: rates,
      createdAt: "2026-10-02T10:00:00.000Z",
    },
    "site-event:draft-secret-unpublished": {
      id: "draft-secret-unpublished", otraGuideId: "7610", otraGuideSlug: "7610", title: "Not Yet Secret", status: "draft",
      frozenSlug: "not-yet-secret", unlisted: true, startDate: "2999-03-01T20:00:00-04:00", claudeDesign: rates,
      createdAt: "2026-10-03T10:00:00.000Z",
    },
    "site-event:draft-secret-admin": {
      id: "draft-secret-admin", otraGuideId: "7620", otraGuideSlug: "7620", title: "Staff Secret", status: "published",
      publishedAt: "2026-10-02T12:00:00.000Z", frozenSlug: "staff-secret", unlisted: true, adminOnly: true,
      startDate: "2999-03-02T20:00:00-04:00", claudeDesign: rates, createdAt: "2026-10-04T10:00:00.000Z",
    },
    "site-event:draft-secret-archived": {
      id: "draft-secret-archived", otraGuideId: "7630", otraGuideSlug: "7630", title: "Archived Secret", status: "published",
      publishedAt: "2026-10-02T12:00:00.000Z", frozenSlug: "archived-secret", unlisted: true,
      startDate: "2999-03-03T20:00:00-04:00", claudeDesign: rates, createdAt: "2026-10-05T10:00:00.000Z",
    },
    "site-event:draft-secret-gone": {
      id: "draft-secret-gone", otraGuideId: "7640", otraGuideSlug: "7640", title: "Gone Secret", status: "published",
      publishedAt: "2026-10-02T12:00:00.000Z", frozenSlug: "gone-secret", unlisted: true,
      startDate: "2999-03-04T20:00:00-04:00", claudeDesign: rates, createdAt: "2026-10-06T10:00:00.000Z",
    },
    "admin:hidden-pages": ["7630"],
  };
}

function makeKv(records) {
  const store = new Map(Object.entries(records));
  const deleted = [];
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      if (type === "json") return JSON.parse(JSON.stringify(value));
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async put(key, value) { store.set(key, typeof value === "string" ? JSON.parse(value) : value); },
    async delete(key) { deleted.push(key); store.delete(key); },
    lists: 0,
    async list({ prefix } = {}) {
      this.lists += 1;
      return { keys: [...store.keys()].filter((name) => !prefix || name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    store,
    deleted,
  };
}

// Upstream Otra Guide: the public category feed lists the secret's Guide
// event (7600, its Guide event is public) and a listed event whose title
// would mint the secret's link.
const UPSTREAM = [
  { id: 7600, title: "Strange Bird Gala Secret", start_date: "2999-02-01T20:00:00-04:00", is_ticketed: true },
  { id: 7700, title: "Strange Bird Gala Secret", start_date: "2999-04-05T20:00:00-04:00", is_ticketed: true },
  { id: 7800, title: "Strange Bird Gala", start_date: "2999-04-06T20:00:00-04:00", is_ticketed: true },
];
function installFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input && input.url ? input.url : input);
    const ok = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/users/user-role/")) return ok({ is_staff_or_admin: true });
    if (/\/events\/\?|\/events\/list|category/.test(url) && !/details/.test(url)) {
      return ok(url.includes("page=1") || !/page=\d/.test(url) ? { count: UPSTREAM.length, results: UPSTREAM } : { results: [] });
    }
    const tickets = url.match(/\/ticket\/purchase\/tickets\/(\d+)\//);
    if (tickets) return ok({ count: 1, results: [{ id: 1, name: "GA", price: "25.00", is_active: true }] });
    const detail = url.match(/\/events\/details\/(\d+)\//);
    if (detail) {
      if (detail[1] === "7640") return new Response("{}", { status: 404 });
      return ok({ id: Number(detail[1]), title: "Event " + detail[1], start_date: "2999-02-01T20:00:00-04:00", end_date: "2999-02-02T02:00:00-04:00" });
    }
    return ok({});
  };
  return () => { globalThis.fetch = real; };
}
const realCaches = globalThis.caches;
globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };

function ctx(kv, path = "/api/homepage-events", extra = {}) {
  return {
    env: { OVERRIDES: kv, OTRA_API_URL: API, ASSETS: assets() },
    request: new Request("https://otratickets.com" + path),
    waitUntil() {},
    ...extra,
  };
}
const EVENT_HTML = '<!doctype html><html><head><title>Event</title><script src="/site-overrides.js"></script></head><body data-event-id=""></body></html>';
function assets() {
  return { async fetch() { return new Response(EVENT_HTML, { headers: { "content-type": "text/html" } }); } };
}

const restoreFetch = installFetch();
try {
  // ── 2. Feeds: never list an unlisted page, staff preview included ──
  {
    const kv = makeKv(baseProjects());
    const unlisted = { ids: new Set(), slugs: new Set() };
    const pub = await buildPublishedSiteEvents(kv && { OVERRIDES: kv, OTRA_API_URL: API }, { unlisted });
    const ids = pub.map((e) => String(e.id));
    assert(ids.includes("7999"), "listed page stays in the site events");
    assert(!ids.includes("7600"), "unlisted page must not be in the public site events");
    assert(unlisted.ids.has("7600") && unlisted.ids.has("draft-secret"), "skipped unlisted ids are reported");
    assert(unlisted.slugs.has("strange-bird-gala-secret"), "skipped unlisted links are reported");
    const staff = await buildPublishedSiteEvents({ OVERRIDES: kv, OTRA_API_URL: API }, { includeAdminOnly: true });
    assert(!staff.some((e) => String(e.id) === "7600"), "staff preview must not list an unlisted page either");
    assert(!staff.some((e) => String(e.id) === "7620"), "an admin only unlisted page is not listed in the staff preview");

    const { events } = await buildHomepageFeed(ctx(kv), {});
    const feedIds = events.map((e) => String(e.id));
    assert(feedIds.includes("7999"), "homepage feed keeps the listed page");
    assert(!feedIds.includes("7600"), "homepage feed must drop the unlisted page even when the upstream Guide feed lists it");
    const twin = events.find((e) => String(e.id) === "7700");
    assert(twin && twin.slug !== "strange-bird-gala-secret", "a listed page never takes an unlisted link, got " + (twin && twin.slug));
    assert(twin && /^strange-bird-gala-secret-[a-z0-9-]+$/.test(twin.slug) && !/draft/.test(twin.slug), "the listed twin gets a plain suffix: " + (twin && twin.slug));
    const other = events.find((e) => String(e.id) === "7800");
    assert(other && other.slug === "strange-bird-gala", "unrelated listed slugs are untouched");

    const sitemap = await (await sitemapRoute(ctx(kv, "/sitemap.xml"))).text();
    assert(sitemap.includes("/listed-party") && !sitemap.includes("/strange-bird-gala-secret<"), "sitemap lists the listed page and never the unlisted link");
    const llms = await (await llmsRoute(ctx(kv, "/llms.txt"))).text();
    assert(!llms.includes("/strange-bird-gala-secret)") && !llms.includes("/strange-bird-gala-secret\n") && !/strange-bird-gala-secret(?!-)/.test(llms), "llms.txt never lists the unlisted link");
    const feedJson = await (await homepageEventsRoute(ctx(kv))).json();
    assert(!feedJson.events.some((e) => e.slug === "strange-bird-gala-secret" || String(e.id) === "7600"), "/api/homepage-events (search) never returns the unlisted page");
  }

  // ── 3. /<slug> opens the unlisted page with noindex; listed wins ──
  {
    const kv = makeKv(baseProjects());
    const feed = await buildHomepageFeed(ctx(kv), {});
    const feedHook = async () => new Response(JSON.stringify({ events: feed.events }), { headers: { "content-type": "application/json" } });
    const open = (slug, hook = feedHook) => slugRoute({ ...ctx(kv, "/" + slug), getHomepageEvents: hook, params: { slug } });

    const res = await open("strange-bird-gala-secret");
    const html = await res.text();
    assert(res.status === 200, "unlisted link must open (200), got " + res.status);
    assert(html.includes('data-event-id="7600"'), "unlisted link serves its own Guide event");
    assert(/<meta name="robots" content="noindex, nofollow"/.test(html), "unlisted page has a noindex robots meta");
    assert(/noindex/.test(res.headers.get("x-robots-tag") || ""), "unlisted page sends X-Robots-Tag noindex");
    assert(!html.includes("application/ld+json"), "unlisted page has no Event rich result");
    assert(html.includes('href="https://otratickets.com/strange-bird-gala-secret"'), "canonical is the short link");

    const listed = await open("listed-party");
    const listedHtml = await listed.text();
    assert(listed.status === 200 && !/name="robots"/.test(listedHtml) && !listed.headers.get("x-robots-tag"), "listed page has no noindex");
    assert(listedHtml.includes("application/ld+json"), "listed page keeps its rich result");

    // A listed page that owns the slug wins over an unlisted page with it.
    const collide = async () => new Response(JSON.stringify({ events: [...feed.events, { id: 7701, title: "Public Owner", slug: "strange-bird-gala-secret" }] }), { headers: { "content-type": "application/json" } });
    const owned = await open("strange-bird-gala-secret", collide);
    const ownedHtml = await owned.text();
    assert(owned.status === 200 && ownedHtml.includes('data-event-id="7701"') && !/noindex/.test(ownedHtml), "a listed page with the same slug wins");

    // Feed down: the unlisted link still opens (it does not depend on the feed).
    const down = await open("strange-bird-gala-secret", async () => { throw new Error("feed down"); });
    assert(down.status === 200, "unlisted link opens even when the feed is down");

    for (const [slug, why] of [["not-yet-secret", "an unpublished unlisted draft"], ["staff-secret", "an admin only unlisted page"], ["archived-secret", "an archived unlisted page"], ["gone-secret", "an unlisted page whose Guide event is gone"], ["no-such-page", "an unknown slug"]]) {
      const r = await open(slug);
      assert(r.status === 404 && r.headers.get("cache-control") === "no-store", why + " must 404 no-store, got " + r.status);
    }
    const found = await findUnlistedSiteEvent(ctx(kv), "strange-bird-gala-secret");
    assert(found && found.unlisted === true && found.title, "findUnlistedSiteEvent returns a card with a title");
  }

  // ── 3b. Unknown slugs use the short lived index, not a scan each time ──
  {
    const kv = makeKv(baseProjects());
    assert(await findUnlistedSiteEvent(ctx(kv), "strange-bird-gala-secret"), "a servable unlisted link is found");
    const before = kv.lists;
    for (let i = 0; i < 20; i += 1) assert((await findUnlistedSiteEvent(ctx(kv), "bot-typo-" + i)) === null, "an unknown slug answers null");
    assert(kv.lists === before, "unknown slugs do not rescan the site events, scans: " + (kv.lists - before));
    kv.store.set("site-event:draft-late", {
      id: "draft-late", otraGuideId: "7670", otraGuideSlug: "7670", title: "Late Secret", status: "published",
      publishedAt: "2026-10-09T12:00:00.000Z", frozenSlug: "late-secret", unlisted: true,
      startDate: "2999-07-01T20:00:00-04:00", claudeDesign: rates, createdAt: "2026-10-09T10:00:00.000Z",
    });
    dropUnlistedIndex(kv);
    assert(await findUnlistedSiteEvent(ctx(kv), "late-secret"), "a new unlisted link opens once the index is dropped");
    const archived = await findUnlistedSiteEvent(ctx(kv), "archived-secret");
    assert(archived === null, "an archived unlisted link stays closed even if indexed");
  }

  // ── 4. /api/event: short link only when it opens ──
  {
    const kv = makeKv(baseProjects());
    const get = async (id) => (await eventRoute(ctx(kv, "/api/event?id=" + id))).json();
    const secret = await get("7600");
    assert(secret.unlisted === true && secret.slug === "strange-bird-gala-secret", "a live unlisted page rewrites to its short link: " + JSON.stringify({ u: secret.unlisted, s: secret.slug }));
    const draft = await get("7610");
    assert(!draft.unlisted && !draft.slug, "an unpublished unlisted page is not noindex yet and never rewrites to a link that 404s: " + JSON.stringify({ u: draft.unlisted, s: draft.slug }));
    const archived = await get("7630");
    assert(archived.unlisted === true && !archived.slug, "an archived unlisted page never rewrites to a link that 404s");
    const listed = await get("7999");
    assert(!listed.unlisted && listed.slug === "listed-party", "listed pages keep their slug");
  }

  // ── 4b. A live listed page is never marked unlisted by another page ──
  {
    const records = baseProjects();
    // A newer unpublished unlisted draft on the live listed event.
    records["site-event:draft-public-redo"] = {
      id: "draft-public-redo", otraGuideId: "7999", otraGuideSlug: "7999", title: "Listed Party", status: "draft",
      frozenSlug: "listed-party-secret", unlisted: true, claudeDesign: rates, createdAt: "2026-10-09T10:00:00.000Z",
    };
    // A newer published unlisted page next to an older published listed one.
    records["site-event:draft-both-listed"] = {
      id: "draft-both-listed", otraGuideId: "7660", otraGuideSlug: "7660", title: "Both Party", status: "published",
      publishedAt: "2026-10-01T12:00:00.000Z", frozenSlug: "both-party", startDate: "2999-06-01T20:00:00-04:00",
      claudeDesign: rates, createdAt: "2026-10-01T10:00:00.000Z",
    };
    records["site-event:draft-both-secret"] = {
      id: "draft-both-secret", otraGuideId: "7660", otraGuideSlug: "7660", title: "Both Party", status: "published",
      publishedAt: "2026-10-08T12:00:00.000Z", frozenSlug: "both-party-secret", unlisted: true,
      startDate: "2999-06-01T20:00:00-04:00", claudeDesign: rates, createdAt: "2026-10-08T10:00:00.000Z",
    };
    const kv = makeKv(records);
    const get = async (id) => (await eventRoute(ctx(kv, "/api/event?id=" + id))).json();
    const redo = await get("7999");
    assert(!redo.unlisted && redo.slug === "listed-party", "an unlisted draft never noindexes or moves the live listed page: " + JSON.stringify({ u: redo.unlisted, s: redo.slug }));
    const both = await get("7660");
    assert(!both.unlisted && both.slug === "both-party", "a listed published page keeps the event listed and at its own link: " + JSON.stringify({ u: both.unlisted, s: both.slug }));
    const { events } = await buildHomepageFeed(ctx(kv), {});
    const card = events.find((e) => String(e.id) === "7660");
    assert(card && card.slug === "both-party", "the feed lists the listed page of that event at its link: " + (card && card.slug));
  }

  // ── 5. Admin action set-unlisted ──
  {
    const post = async (kv, query) => {
      const response = await projectsPost({
        ...ctx(kv, "/admin/api/projects?" + query),
        request: new Request("https://otratickets.com/admin/api/projects?" + query, { method: "POST", headers: { authorization: "Bearer t" } }),
      });
      return { status: response.status, body: await response.json() };
    };
    const records = baseProjects();
    records["site-event:draft-new"] = {
      id: "draft-new", otraGuideId: "7650", otraGuideSlug: "7650", title: "Listed Party (clone)", status: "draft",
      startDate: "2999-05-01T20:00:00-04:00", claudeDesign: rates, createdAt: "2026-10-07T10:00:00.000Z",
    };
    records[SNAP_KEY] = { events: [], rows: [], builtAt: Date.now() };
    const kv = makeKv(records);

    const draftOn = await post(kv, "action=set-unlisted&id=draft-new&value=true");
    assert(draftOn.status === 200 && draftOn.body.project.unlisted === true, "toggle on works on a draft");
    assert(draftOn.body.project.frozenSlug === "listed-party-2", "a draft whose title link is taken by a listed page gets -2: " + draftOn.body.project.frozenSlug);
    assert(kv.deleted.includes(SNAP_KEY), "toggling drops the feed snapshot");
    assert(kv.store.get("site-event:draft-new").unlisted === true, "unlisted is stored");

    const typedTaken = await post(kv, "action=set-unlisted&id=draft-new&value=true&slug=strange-bird-gala-secret");
    assert(typedTaken.status === 409 && /Strange Bird Gala Secret/.test(typedTaken.body.error), "typing another unlisted page's link is refused");
    const typedListed = await post(kv, "action=set-unlisted&id=draft-new&value=true&slug=listed-party");
    assert(typedListed.status === 409, "typing a listed page's link is refused");
    const typedBad = await post(kv, "action=set-unlisted&id=draft-new&value=true&slug=admin");
    assert(typedBad.status === 400, "typing a site path is refused");
    const typedOk = await post(kv, "action=set-unlisted&id=draft-new&value=true&slug=" + encodeURIComponent("Strange Bird Afterparty"));
    assert(typedOk.status === 200 && typedOk.body.project.frozenSlug === "strange-bird-afterparty", "a typed free link is cleaned and saved");
    // Warm the index, then a link change by the admin must open at once.
    await findUnlistedSiteEvent(ctx(kv), "warm-index");
    const secretNew = await post(kv, "action=set-unlisted&id=draft-secret&value=true&slug=strange-bird-new-link");
    assert(secretNew.status === 200 && secretNew.body.project.frozenSlug === "strange-bird-new-link", "a live unlisted page link can be edited");
    assert(await findUnlistedSiteEvent(ctx(kv), "strange-bird-new-link"), "the edited link opens right away (index dropped)");
    assert((await findUnlistedSiteEvent(ctx(kv), "strange-bird-gala-secret")) === null, "the old link stops opening");

    const own = await post(kv, "action=set-unlisted&id=draft-public&value=true");
    assert(own.status === 200 && own.body.project.frozenSlug === "listed-party", "a listed page made unlisted keeps its own link");

    const off = await post(kv, "action=set-unlisted&id=draft-public&value=false");
    assert(off.status === 200 && off.body.project.unlisted === false && off.body.project.frozenSlug === "listed-party", "toggle off lists it again and keeps the link");

    const keep = await post(kv, "action=rename&id=draft-secret");
    void keep;
    const normalized = kv.store.get("site-event:draft-secret");
    assert(normalized.unlisted === true, "other admin actions keep the unlisted flag");
  }

  // ── 6. Admin list: a live page carries its draft's switch ──
  {
    const kv = makeKv(baseProjects());
    const response = await pagesGet({
      ...ctx(kv, "/admin/api/pages"),
      request: new Request("https://otratickets.com/admin/api/pages", { headers: { authorization: "Bearer t" } }),
    });
    const { pages } = await response.json();
    const live = pages.find((page) => String(page.id) === "7600");
    assert(live && live.projectId === "draft-secret" && live.unlisted === true && live.frozenSlug === "strange-bird-gala-secret", "the live entry of a published page carries projectId, unlisted and its link: " + JSON.stringify(live));
    const listed = pages.find((page) => String(page.id) === "7999");
    assert(listed && listed.projectId === "draft-public" && listed.unlisted === false, "a listed live page can be switched to unlisted from its live entry");
    const draft = pages.find((page) => page.id === "draft-secret-unpublished");
    assert(draft && draft.unlisted === true && draft.frozenSlug === "not-yet-secret", "draft entries carry unlisted and the link");
  }
} finally {
  restoreFetch();
  if (realCaches === undefined) delete globalThis.caches;
  else globalThis.caches = realCaches;
}

// ── 7. Wiring ──
{
  const admin = readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
  assert(/id="unlistedToggle"/.test(admin) && /Unlisted \(link only\)/.test(admin), "admin has the Unlisted (link only) toggle");
  assert(/id="copyUnlistedLinkBtn"[^>]*>Copy link</.test(admin), "admin has Copy link");
  assert(/id="editUnlistedLinkBtn"[^>]*>Edit link</.test(admin), "admin has Edit link");
  assert(/action: "set-unlisted", id: projectId/.test(admin), "toggle posts set-unlisted for the live draft id");
  assert(/if \(page\.projectId\) return page\.projectId;/.test(admin), "a live page entry uses its draft for the switch");
  assert(/navigator\.clipboard\.writeText\(link\)/.test(admin), "Copy link writes the link to the clipboard");
  assert(/location\.origin \+ "\/" \+ page\.frozenSlug/.test(admin), "the copied link is origin + / + short slug");
  assert(/starts working after Publish/.test(admin), "admin says a draft link works after Publish");
  assert(/addEventListener\("change", \(\) => setUnlisted/.test(admin) && /addEventListener\("click", copyUnlistedLink\)/.test(admin), "toggle and Copy link listeners are bound");
  const pages = readFileSync(new URL("../functions/admin/api/pages.js", import.meta.url), "utf8");
  assert(/unlisted: project\.unlisted === true/.test(pages) && /frozenSlug:/.test(pages), "pages list exposes unlisted and frozenSlug");
  const eventHtml = readFileSync(new URL("../event.html", import.meta.url), "utf8");
  assert(/if \(ev\.unlisted && !document\.querySelector\('meta\[name="robots"\]'\)\)/.test(eventHtml), "event page adds noindex for unlisted pages");
  assert(/ev\.slug && !ev\.staffPreview/.test(eventHtml), "event page only rewrites when the API gives a slug");
}

if (failures.length) {
  console.error("check-unlisted-link-only FAILED:");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}
console.log("check-unlisted-link-only OK (off every feed, opens at its short link with noindex, listed wins, no dead rewrite, admin wired)");
