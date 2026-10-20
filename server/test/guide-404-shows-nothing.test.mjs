import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onRequestGet as getEvent } from "../../functions/api/event.js";
import { onRequestGet as getOverride } from "../../functions/api/override.js";
import { onRequestGet as getSlug } from "../../functions/[slug].js";
import { buildHomepageFeed, dropHiddenGuideEvents } from "../../functions/_lib/homepage-feed.js";
import { forgetGuideStatuses, guideDetailMissing } from "../../functions/_lib/guide-event-hidden.js";

// When Otra Guide answers 404 for an event detail, the storefront shows
// nothing for it: no event JSON, no draft page, no page edits, no card.
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const published = (id, guideId, extra = {}) => ({
  id,
  otraGuideId: guideId,
  status: "published",
  adminOnly: false,
  title: `Event ${guideId}`,
  description: `Story of ${guideId}`,
  startDate: iso(now + 20 * DAY),
  endDate: iso(now + 20 * DAY + 4 * 3600e3),
  createdAt: "2026-08-20T12:00:00.000Z",
  claudeDesign: { rates: [{ name: "Early Rooster", price: 37.5, currency: "XCG" }] },
  ...extra,
});

const kaya = published("draft-kaya", "7567", {
  title: "Kaya Kaya Festival 2026",
  frozenSlug: "kaya-kaya-festival-2026",
  startDate: "2026-09-26T18:00:00-04:00",
  endDate: "2026-09-26T00:00:00-04:00",
});
const live = published("draft-live", "7479", { title: "Bingo Bengo", frozenSlug: "bingo-bengo" });
const p8088 = published("draft-1791253678425-26c548a5", "8088", { title: "Fund Raiser", frozenSlug: "fund-raiser" });
const unbound = published("draft-unbound", "", { title: "Unbound Draft" });

const docs = {
  "event:7567": { description: "KAYA EDIT", fields: { "text:#evTitle": { type: "text", value: "Kaya Kaya Festival 2026" } } },
  "event:draft-kaya": { fields: { "text:#evTitle": { type: "text", value: "Kaya draft title" } } },
  "event:7479": { fields: { "text:#evTitle": { type: "text", value: "Bingo Bengo" } } },
  "event:8088": { fields: { "text:#evTitle": { type: "text", value: "Fund Raiser" } } },
};

function kvWith(projects, extra = docs) {
  const byKey = new Map([...projects.map((p) => [`site-event:${p.id}`, p]), ...Object.entries(extra)]);
  return {
    async list({ prefix } = {}) {
      return { keys: [...byKey.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    async get(key) { return byKey.has(key) ? byKey.get(key) : null; },
  };
}

const details = {
  7479: { id: 7479, title: "Bingo Bengo", start_date: iso(now + 20 * DAY), end_date: iso(now + 20 * DAY + 3 * 3600e3), is_ticketed: true, is_perennial: false },
  7522: { id: 7522, title: "Bingo Bengo Sep", start_date: "2026-09-06T17:00:00-04:00", end_date: "2026-09-06T20:00:00-04:00", is_ticketed: true, is_perennial: false },
};

async function withUpstream(fn, { guideDown = false, staffToken = "" } = {}) {
  forgetGuideStatuses();
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const calls = [];
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const path = url.pathname;
    calls.push(path);
    const auth = (init.headers && (init.headers.authorization || init.headers.Authorization)) || "";
    if (path === "/api/users/user-role/") {
      return Response.json({ is_staff_or_admin: Boolean(staffToken) && auth === `Bearer ${staffToken}` });
    }
    let m;
    if ((m = path.match(/^\/api\/events\/details\/(\d+)\/$/))) {
      if (guideDown) return new Response("upstream error", { status: 502 });
      if (auth && staffToken && auth === `Bearer ${staffToken}` && m[1] === "7567") return Response.json({ id: 7567, title: "Kaya Kaya Festival 2026", start_date: kaya.startDate, end_date: kaya.endDate, is_ticketed: true });
      return details[m[1]] ? Response.json(details[m[1]]) : Response.json({ detail: "No Event matches the given query." }, { status: 404 });
    }
    if (/^\/api\/ticket\/purchase\/tickets\/\d+\/$/.test(path)) {
      return Response.json({ count: 1, results: [{ id: 468, name: "Early Rooster", price: 37.5, base_currency: { code: "XCG" } }] });
    }
    if (path === "/api/events/nonperennial/") {
      // The public listing never carries a hidden event.
      return Response.json({ count: 1, results: url.searchParams.get("page") === "1" ? [{ ...details[7479], is_ticketed: true }] : [] });
    }
    if (/^\/ticketing\/stripe-external-iframe\/calendar\/\d+\/$/.test(path)) return new Response("", { status: 200 });
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

const env = (projects) => ({ OVERRIDES: kvWith(projects), OTRA_API_URL: "https://guide.test/api" });
const ctx = (path, projects, headers = {}) => ({ request: new Request(`https://tickets.test${path}`, { headers }), env: env(projects), waitUntil() {} });

async function event(id, projects, headers) {
  const response = await getEvent(ctx(`/api/event?id=${id}`, projects, headers));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text, cacheControl: response.headers.get("cache-control") };
}

async function override(id, projects, headers) {
  const response = await getOverride(ctx(`/api/override?id=${id}`, projects, headers));
  return (await response.json()).override;
}

const all = [kaya, live, p8088, unbound];

test("/api/event?id= shows nothing for a Guide 404, even with a published ended project", async () => {
  await withUpstream(async () => {
    const { status, body, text } = await event("7567", all);
    assert.equal(status, 404);
    assert.deepEqual(body, { error: "not found" });
    assert.equal(/Kaya|Early Rooster|XCG/.test(text), false);
  });
});

test("the draft URL of a project bound to a Guide 404 shows nothing", async () => {
  await withUpstream(async () => {
    const { status, text } = await event("draft-kaya", all);
    assert.equal(status, 404);
    assert.equal(/Kaya|Early Rooster/.test(text), false);
  });
});

test("staff still preview a hidden event's draft, never cached", async () => {
  await withUpstream(async () => {
    const { status, body, cacheControl } = await event("draft-kaya", all, { authorization: "Bearer staff-1" });
    assert.equal(status, 200);
    assert.equal(body.staffPreview, true);
    assert.equal(cacheControl, "no-store");
  }, { staffToken: "staff-1" });
});

test("an outage is not a 404: bound draft pages and page edits stay up while Guide errors", async () => {
  await withUpstream(async () => {
    assert.equal((await event("draft-live", all)).status, 200);
    assert.ok(await override("7479", all), "edits stay");
  }, { guideDown: true });
});

test("unbound drafts and live events are unaffected", async () => {
  await withUpstream(async (calls) => {
    const draft = await event("draft-unbound", all);
    assert.equal(draft.status, 200);
    assert.equal(calls.length, 0, "an unbound draft has no Guide event to check");
    const current = await event("7479", all);
    assert.equal(current.status, 200);
    assert.equal(current.body.isPast, false);
    const ended = await event("7522", all);
    assert.equal(ended.status, 200);
    assert.equal(ended.body.isPast, true, "an ended public event stays read only");
  });
});

test("8088 keeps its page and checkout while its Guide detail is hidden and its ticket feed is live", async () => {
  await withUpstream(async () => {
    const { status, body } = await event("8088", all);
    assert.equal(status, 200);
    assert.equal(body.id, 8088);
    assert.equal(body.isPast, false);
    assert.equal((await event("draft-1791253678425-26c548a5", all)).status, 200);
    assert.ok(await override("8088", all));
  });
});

test("/api/override returns no edits for a hidden Guide event or its draft, but staff keep them", async () => {
  await withUpstream(async () => {
    assert.equal(await override("7567", all), null);
    assert.equal(await override("draft-kaya", all), null);
    assert.ok(await override("7479", all), "a live event keeps its edits");
    assert.ok(await override("7567", all, { authorization: "Bearer staff-1" }), "the admin preview keeps its edits");
  }, { staffToken: "staff-1" });
});

test("the homepage feed (and so search, the sitemap and slug pages) never lists a hidden Guide event", async () => {
  await withUpstream(async () => {
    const { events } = await buildHomepageFeed(ctx("/api/homepage-events", all), {});
    const ids = events.map((e) => String(e.id));
    assert.equal(ids.includes("7567"), false, "the hidden event is gone");
    assert.ok(ids.includes("7479"), "a listed live event stays");
    assert.ok(ids.includes("8088"), "8088 stays while it keeps selling");
    assert.ok(ids.includes("draft-unbound"), "unbound drafts are not checked");
    assert.equal(events.some((e) => e.slug === "kaya-kaya-festival-2026"), false);
  });
});

test("an event in the public listing is never rechecked, and an outage keeps cards", async () => {
  await withUpstream(async (calls) => {
    const kept = await dropHiddenGuideEvents([{ id: "7479" }], [{ id: 7479 }], env(all));
    assert.equal(kept.length, 1);
    assert.equal(calls.length, 0);
  });
  await withUpstream(async () => {
    const kept = await dropHiddenGuideEvents([{ id: "7567" }], [], env(all));
    assert.equal(kept.length, 1, "a 502 never hides a card");
  }, { guideDown: true });
});

test("the slug page of a hidden Guide event is the site's not found response", async () => {
  await withUpstream(async () => {
    const context = {
      ...ctx("/kaya-kaya-festival-2026", all),
      params: { slug: "kaya-kaya-festival-2026" },
      getHomepageEvents: async (c) => Response.json(await buildHomepageFeed(c, {})),
    };
    context.env.ASSETS = { fetch: async () => new Response("<html data-event-id=\"\"></html>", { status: 200 }) };
    const response = await getSlug(context);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found");
  });
});

test("event.html renders an empty not found state on a 404, with no event content", () => {
  const html = readFileSync(new URL("../../event.html", import.meta.url), "utf8");
  assert.match(html, /if \(resp\.status === 404\) \{ resp\.text\(\)\.catch\(\(\) => ""\); showNotFound\(\); return; \}/);
  const start = html.indexOf("function showNotFound()");
  const body = html.slice(start, html.indexOf("function revealAll()", start));
  assert.ok(start > 0);
  assert.match(body, /querySelectorAll\(":scope > section"\)\.forEach\(\(el\) => el\.remove\(\)\)/, "every event section is removed");
  assert.match(body, /<h1>Event not found<\/h1>/);
  assert.equal(/id="ev/.test(body), false, "no element the page edits can target");
  assert.match(body, /robots\.content = "noindex"/);
});

test("a found or 404 answer is remembered briefly; an error is asked again", async () => {
  await withUpstream(async (calls) => {
    assert.equal(await guideDetailMissing("https://guide.test/api", "7567"), true);
    assert.equal(await guideDetailMissing("https://guide.test/api", "7567"), true);
    assert.equal(await guideDetailMissing("https://guide.test/api", "7479"), false);
    assert.equal(await guideDetailMissing("https://guide.test/api", "7479"), false);
    assert.equal(calls.length, 2);
  });
  await withUpstream(async (calls) => {
    assert.equal(await guideDetailMissing("https://guide.test/api", "7567"), false);
    assert.equal(await guideDetailMissing("https://guide.test/api", "7567"), false);
    assert.equal(calls.length, 2, "a 502 is not remembered");
  }, { guideDown: true });
});
