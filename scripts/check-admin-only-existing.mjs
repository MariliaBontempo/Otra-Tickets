#!/usr/bin/env node
// Oracle: Admin only on existing (published) pages. The switch saves only
// adminOnly (status, frozenSlug, unlisted and keep selling stay as they are),
// is strict, refuses a stale editor (409), writes a History entry per real
// change and none for a no op, hides the page from the feed, its unlisted link
// and /api/event for the public (staff still preview), and turning it off
// restores the previous listed or link only state. The admin editor shows the
// switch on published rows (projectId) and sends the draft id plus expected.
// Run: node scripts/check-admin-only-existing.mjs

import { readFileSync } from "node:fs";
import { buildPublishedSiteEvents, dropUnlistedIndex, invalidatePublicFeed } from "../functions/_lib/homepage-feed.js";
import { isServableUnlisted } from "../functions/_lib/unlisted.js";
import { forgetGuideStatuses } from "../functions/_lib/guide-event-hidden.js";
import { onRequestGet as eventRoute } from "../functions/api/event.js";
import { onRequestPost as projectsPost } from "../functions/admin/api/projects.js";

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };
const API = "https://og.test/api";
const rates = { rates: [{ name: "General Admission", price: "25.00" }] };

// ── Fixtures: a listed published page and an unlisted published page that
// keeps selling while its Guide event is private ──
function baseProjects() {
  return {
    "site-event:draft-listed": {
      id: "draft-listed", otraGuideId: "7999", otraGuideSlug: "7999", title: "Listed Party", status: "published",
      publishedAt: "2026-10-01T12:00:00.000Z", frozenSlug: "listed-party",
      startDate: "2999-01-01T20:00:00-04:00", endDate: "2999-01-02T02:00:00-04:00", claudeDesign: rates,
      createdAt: "2026-10-01T10:00:00.000Z",
    },
    "site-event:draft-secret": {
      id: "draft-secret", otraGuideId: "7600", otraGuideSlug: "7600", title: "Strange Bird Gala Secret", status: "published",
      publishedAt: "2026-10-02T12:00:00.000Z", frozenSlug: "strange-bird-gala-secret", unlisted: true,
      keepSellingWhileGuidePrivate: true,
      startDate: "2999-02-01T20:00:00-04:00", endDate: "2999-02-02T02:00:00-04:00", claudeDesign: rates,
      createdAt: "2026-10-02T10:00:00.000Z",
    },
  };
}

function makeKv(records) {
  const store = new Map(Object.entries(records));
  const puts = [];
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      if (type === "json") return JSON.parse(JSON.stringify(value));
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async put(key, value) { puts.push(key); store.set(key, typeof value === "string" ? JSON.parse(value) : value); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      return { keys: [...store.keys()].filter((name) => !prefix || name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    store,
    puts,
  };
}

// Upstream Otra Guide: every event public, staff role for any Bearer token.
function installFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input && input.url ? input.url : input);
    const ok = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/users/user-role/")) return ok({ is_staff_or_admin: true });
    // Staff Guide title read (the admin preview asks for it).
    const media = url.match(/\/otra-tickets\/media\/event-slug\/(\d+)\//);
    if (media) return ok({ id: Number(media[1]), slug: media[1], title: "Event " + media[1] });
    if (/\/ticket\/purchase\/tickets\/\d+\//.test(url)) return ok({ count: 1, results: [{ id: 1, name: "GA", price: "25.00", is_active: true }] });
    const detail = url.match(/\/events\/details\/(\d+)\//);
    if (detail) return ok({ id: Number(detail[1]), title: "Event " + detail[1], start_date: "2999-02-01T20:00:00-04:00", end_date: "2999-02-02T02:00:00-04:00" });
    return ok({ results: [] });
  };
  return () => { globalThis.fetch = real; };
}
const realCaches = globalThis.caches;
globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };

function ctx(kv, path, init) {
  return {
    env: { OVERRIDES: kv, OTRA_API_URL: API },
    request: new Request("https://otratickets.com" + path, init),
    waitUntil() {},
  };
}

async function fresh(kv) {
  forgetGuideStatuses();
  dropUnlistedIndex(kv);
  await invalidatePublicFeed(kv);
}

const STAFF = { headers: { authorization: "Bearer staff-token" } };
async function post(kv, query) {
  const res = await projectsPost(ctx(kv, "/admin/api/projects?" + query, { method: "POST", ...STAFF }));
  return { status: res.status, body: await res.json() };
}
const auditFields = (kv, id) => {
  const entries = kv.store.get(`audit:event:${id}`);
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => entry.changedFields || []);
};
const feedIds = async (kv) => (await buildPublishedSiteEvents({ OVERRIDES: kv, OTRA_API_URL: API })).map((e) => String(e.id));
const publicEvent = (kv, id) => eventRoute(ctx(kv, `/api/event?id=${id}`));
const staffEvent = (kv, id) => eventRoute(ctx(kv, `/api/event?id=${id}`, STAFF));

const restoreFetch = installFetch();
try {
  // ── 1. Published page: only adminOnly changes ──
  {
    const kv = makeKv(baseProjects());
    const before = kv.store.get("site-event:draft-secret");
    const on = await post(kv, "action=set-admin-only&id=draft-secret&value=true&expected=false");
    assert(on.status === 200 && on.body.project && on.body.project.adminOnly === true, "set true answers 200 with adminOnly true, got " + on.status);
    const saved = kv.store.get("site-event:draft-secret");
    assert(saved.adminOnly === true, "set true saves adminOnly true");
    assert(saved.status === "published", "a published page stays published");
    assert(saved.frozenSlug === before.frozenSlug, "frozenSlug is untouched");
    assert(saved.unlisted === true, "unlisted is untouched");
    assert(saved.keepSellingWhileGuidePrivate === true, "keep selling is untouched");

    // ── 2. History: one entry per real change, none for a no op ──
    assert(JSON.stringify(auditFields(kv, "draft-secret")) === JSON.stringify(["adminOnly:true"]), "History records adminOnly:true, got " + JSON.stringify(auditFields(kv, "draft-secret")));
    const putsBefore = kv.puts.length;
    const same = await post(kv, "action=set-admin-only&id=draft-secret&value=true");
    assert(same.status === 200 && same.body.project.adminOnly === true, "a no op answers 200 with the page");
    assert(kv.puts.length === putsBefore, "a no op writes nothing (no save, no History, no feed drop), puts: " + kv.puts.slice(putsBefore).join(","));
    const off = await post(kv, "action=set-admin-only&id=draft-secret&value=false&expected=true");
    assert(off.status === 200 && off.body.project.adminOnly === false, "set false answers 200 with adminOnly false");
    const fields = auditFields(kv, "draft-secret").sort();
    assert(JSON.stringify(fields) === JSON.stringify(["adminOnly:false", "adminOnly:true"]),
      "History has exactly adminOnly:true and adminOnly:false (no op adds none), got " + JSON.stringify(fields));
  }

  // ── 3. Errors: strict value, bad id, missing page, stale editor ──
  {
    const kv = makeKv(baseProjects());
    for (const query of ["value=yes", "value=", "", "value=TRUE", "value=true&expected=maybe"]) {
      const res = await post(kv, "action=set-admin-only&id=draft-listed" + (query ? "&" + query : ""));
      assert(res.status === 400, `"${query}" must be 400, got ${res.status}`);
    }
    assert((await post(kv, "action=set-admin-only&id=7999&value=true")).status === 400, "a non draft id is 400");
    assert((await post(kv, "action=set-admin-only&id=draft-nope&value=true")).status === 404, "a missing page is 404");
    const stale = await post(kv, "action=set-admin-only&id=draft-listed&value=false&expected=true");
    assert(stale.status === 409 && stale.body.error === "Page changed. Reload and retry.", "a stale expected is 409, got " + stale.status);
    assert(stale.body.project && stale.body.project.id === "draft-listed", "409 returns the current page so the editor can reload");
    assert(kv.puts.length === 0, "errors write nothing, puts: " + kv.puts.join(","));
    assert(kv.store.get("site-event:draft-listed").adminOnly !== true, "errors leave the page public");
    assert(auditFields(kv, "draft-listed").length === 0, "errors add no History");
  }

  // ── 4 + 5. Public hide, then off again restores the previous state ──
  {
    const kv = makeKv(baseProjects());
    await fresh(kv);
    assert((await feedIds(kv)).includes("7999"), "listed page starts in the feed");
    assert(isServableUnlisted(kv.store.get("site-event:draft-secret")), "unlisted page starts servable at its link");
    assert((await publicEvent(kv, "7999")).status === 200, "listed page starts public on /api/event");

    await post(kv, "action=set-admin-only&id=draft-listed&value=true&expected=false");
    await post(kv, "action=set-admin-only&id=draft-secret&value=true&expected=false");
    await fresh(kv);
    assert(!(await feedIds(kv)).includes("7999"), "admin only listed page leaves the feed");
    assert(!isServableUnlisted(kv.store.get("site-event:draft-secret")), "admin only unlisted page stops serving at its link");
    assert((await publicEvent(kv, "7999")).status === 404, "admin only page is 404 on /api/event for the public");
    assert((await publicEvent(kv, "draft-listed")).status === 404, "admin only page is 404 by draft id for the public");
    assert((await staffEvent(kv, "7999")).status === 200, "staff still preview an admin only page on /api/event");

    await post(kv, "action=set-admin-only&id=draft-listed&value=false&expected=true");
    await post(kv, "action=set-admin-only&id=draft-secret&value=false&expected=true");
    await fresh(kv);
    assert((await feedIds(kv)).includes("7999"), "off again: listed page is back in the feed");
    assert((await publicEvent(kv, "7999")).status === 200, "off again: listed page is public on /api/event");
    const secret = kv.store.get("site-event:draft-secret");
    assert(isServableUnlisted(secret), "off again: unlisted page serves at its link");
    assert(secret.frozenSlug === "strange-bird-gala-secret" && secret.unlisted === true, "off again: same link, still unlisted");
    assert(!(await feedIds(kv)).includes("7600"), "off again: unlisted page stays off the feed");
  }

  // ── 6. Admin editor: switch on published rows, draft id + expected sent ──
  {
    const html = readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
    assert(/\$\("adminOnlyWrap"\)\.classList\.toggle\("hidden",\s*!unlistedProjectId\(selected\)\)/.test(html), "adminOnlyWrap shows whenever unlistedProjectId(selected) is set");
    assert(!/\$\("adminOnlyWrap"\)\.classList\.toggle\("hidden",\s*!isDraft\(selected\)\)/.test(html), "adminOnlyWrap no longer depends on isDraft only");
    const fn = (html.match(/async function setAdminOnly\(\) \{[\s\S]*?\n  \}\n/) || [""])[0];
    assert(fn, "setAdminOnly exists");
    assert(/const projectId = unlistedProjectId\(selected\)/.test(fn), "setAdminOnly targets unlistedProjectId(selected)");
    assert(/action: "set-admin-only", id: projectId/.test(fn), "setAdminOnly posts set-admin-only with the draft id");
    assert(/expected: String\(previous\)/.test(fn), "setAdminOnly sends expected = the value the editor last saw");
    assert(/unlistedProjectId\(row\) !== projectId/.test(fn) && /row\.adminOnly = page\.adminOnly/.test(fn), "setAdminOnly updates every row of the same draft");
    assert(/renderKeepSellingControls\(\)/.test(fn) && /refreshPreview\(\)/.test(fn), "setAdminOnly redraws keep selling and refreshes the preview");
    assert(fn.includes("Admin only. Hidden from the public page, API and checkout.") && fn.includes("Public again.") &&
      fn.includes("Unlisted again. Anyone with the link can open it."), "setAdminOnly uses the on, public and unlisted status texts");
    assert(/checked = previous/.test(fn), "setAdminOnly reverts the checkbox on error");
    assert(/id="adminOnlyWrap" title="Even after publishing/.test(html), "the tooltip stays");
  }
} finally {
  restoreFetch();
  globalThis.caches = realCaches;
}

if (failures.length) {
  console.error(`check-admin-only-existing: ${failures.length} failure(s)`);
  for (const message of failures) console.error("  - " + message);
  process.exit(1);
}
console.log("check-admin-only-existing: ok");
