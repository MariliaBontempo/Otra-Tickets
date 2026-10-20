import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onRequestGet } from "../../functions/api/event.js";
import { eventEndTime, hasEnded, ENDED_GRACE_MS } from "../../functions/_lib/event-ended.js";

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// Kaya Kaya Festival 2026 shape: the Guide detail is gone (hidden from
// anonymous callers) while the ticket types are still public, and the
// published site project stores the end day at 00:00.
const kaya = {
  id: "draft-kaya",
  otraGuideId: "7567",
  status: "published",
  adminOnly: false,
  title: "Kaya Kaya Festival 2026",
  description: "THE FESTIVAL",
  image: "/override-images/draft-kaya/hero.png",
  frozenSlug: "kaya-kaya-festival-2026",
  startDate: "2026-09-26T18:00:00-04:00",
  endDate: "2026-09-26T00:00:00-04:00",
  createdAt: "2026-08-20T12:00:00.000Z",
  claudeDesign: { meta: ["Sat, September 26", "4:00 PM - 2:00 AM"], rates: [{ name: "Early Rooster", price: 37.5, currency: "XCG" }] },
};

function project(overrides) {
  return { ...kaya, ...overrides };
}

function kvWith(projects) {
  const byKey = new Map(projects.map((p) => [`site-event:${p.id}`, p]));
  return {
    async list() { return { keys: [...byKey.keys()].map((name) => ({ name })), list_complete: true }; },
    async get(key) { return byKey.has(key) ? byKey.get(key) : null; },
  };
}

const now = Date.now();
const details = {
  // Ended, public detail.
  7522: { id: 7522, title: "Bingo Bengo", start_date: "2026-09-06T17:00:00-04:00", end_date: "2026-09-06T20:00:00-04:00", is_ticketed: true, is_perennial: false },
  // Current, public detail.
  7479: { id: 7479, title: "Bingo Bengo December", start_date: iso(now + 30 * DAY), end_date: iso(now + 30 * DAY + 3 * 3600e3), is_ticketed: true, is_perennial: false },
  // Running right now.
  7480: { id: 7480, title: "Running Now", start_date: iso(now - 3600e3), end_date: iso(now + 3600e3), is_ticketed: true, is_perennial: false },
  // A series whose parent end passed while later dates still sell.
  7481: { id: 7481, title: "Weekly Series", start_date: "2026-01-01T18:00:00-04:00", end_date: "2026-01-01T22:00:00-04:00", is_ticketed: true, is_perennial: false, has_mini_events: true },
  // A perennial tour with an old parent date.
  6827: { id: 6827, title: "Iguana Tour", start_date: "2026-03-06T09:30:00-04:00", end_date: "2026-03-06T11:30:00-04:00", is_ticketed: true, is_perennial: true },
};

async function withUpstream(fn) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const calls = [];
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (input) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname;
    calls.push(path);
    let m;
    if ((m = path.match(/^\/api\/events\/details\/(\d+)\/$/))) {
      return details[m[1]] ? Response.json(details[m[1]]) : Response.json({ detail: "No Event matches the given query." }, { status: 404 });
    }
    if (/^\/api\/ticket\/purchase\/tickets\/\d+\/$/.test(path)) {
      return Response.json({ results: [{ id: 468, name: "Early Rooster", price: 37.5, base_currency: { code: "XCG" } }] });
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

async function get(id, projects = [], headers = {}) {
  const env = { OVERRIDES: kvWith(projects), OTRA_API_URL: "https://guide.test/api" };
  const response = await onRequestGet({ request: new Request(`https://tickets.test/api/event?id=${id}`, { headers }), env, waitUntil() {} });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text, cacheControl: response.headers.get("cache-control") };
}

test("hasEnded uses the end date, or a day after the start when the end is missing or earlier", () => {
  const start = "2026-09-26T18:00:00-04:00";
  assert.equal(eventEndTime(start, "2026-09-27T02:00:00-04:00"), Date.parse("2026-09-27T02:00:00-04:00"));
  assert.equal(eventEndTime(start, "2026-09-26T00:00:00-04:00"), Date.parse(start) + ENDED_GRACE_MS);
  assert.equal(eventEndTime(start, ""), Date.parse(start) + ENDED_GRACE_MS);
  assert.equal(eventEndTime(null, "2026-09-27T02:00:00-04:00"), Date.parse("2026-09-27T02:00:00-04:00"));
  assert.equal(eventEndTime(null, null), null);
  assert.equal(eventEndTime("not a date", undefined), null);
  assert.equal(hasEnded(start, "2026-09-26T00:00:00-04:00"), true);
  assert.equal(hasEnded(iso(now - 3600e3), iso(now + 3600e3)), false);
  assert.equal(hasEnded(iso(now - 3600e3), ""), false, "started an hour ago with no end is still on");
  assert.equal(hasEnded(null, null), false);
  assert.equal(hasEnded(start, "2026-09-27T02:00:00-04:00", Date.parse("2026-09-27T01:00:00-04:00")), false);
});

test("a past event whose Guide detail is hidden still loads its published page, read only", async () => {
  await withUpstream(async () => {
    const { status, body, text, cacheControl } = await get("7567", [kaya]);
    assert.equal(status, 200);
    assert.equal(body.id, 7567);
    assert.equal(body.title, "Kaya Kaya Festival 2026");
    assert.equal(body.description, "THE FESTIVAL");
    assert.equal(body.image, "/override-images/draft-kaya/hero.png");
    assert.equal(body.slug, "kaya-kaya-festival-2026");
    assert.equal(body.isPast, true, "the page must not offer checkout");
    assert.equal(body.checkoutEventId, "7567");
    assert.equal(body.startDate, kaya.startDate);
    assert.equal(body.isDraft, false);
    assert.deepEqual(body.design.meta, kaya.claudeDesign.meta);
    assert.deepEqual(body.tickets, [{ name: "Early Rooster", description: "", price: 37.5, currency: "XCG" }], "the Guide ticket types stay the record");
    assert.equal(/projectDates/.test(text), false, "internal project dates never reach the JSON");
    assert.equal(cacheControl, "public, max-age=60");
  });
});

test("a staff only Guide event that has not ended stays hidden", async () => {
  await withUpstream(async () => {
    const future = project({ startDate: iso(now + 10 * DAY), endDate: iso(now + 10 * DAY + 8 * 3600e3) });
    assert.equal((await get("7567", [future])).status, 404, "future dates");
    const running = project({ startDate: iso(now - 3600e3), endDate: iso(now + 3600e3) });
    assert.equal((await get("7567", [running])).status, 404, "running now");
    const undated = project({ startDate: "", endDate: "" });
    assert.equal((await get("7567", [undated])).status, 404, "no dates");
    assert.equal((await get("7567", [project({ adminOnly: true })])).status, 404, "admin only project");
    assert.equal((await get("7567", [project({ status: "draft" })])).status, 404, "unpublished project");
    assert.equal((await get("7567", [project({ isPerennial: true })])).status, 404, "perennial project");
    assert.equal((await get("7567", [project({ archivedAt: "2026-10-01T00:00:00.000Z" })])).status, 404, "archived project");
    assert.equal((await get("7567", [project({ otraGuideId: "7568" })])).status, 404, "project bound to another event");
    assert.equal((await get("7567", [])).status, 404, "no project at all");
  });
});

test("a past project page falls back to its own rates when the Guide ticket feed is empty", async () => {
  await withUpstream(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      if (/^\/api\/ticket\/purchase\/tickets\/7567\/$/.test(path)) return Response.json({ results: [] });
      return originalFetch(input);
    };
    const { status, body } = await get("7567", [kaya]);
    assert.equal(status, 200);
    assert.equal(body.isPast, true);
    assert.deepEqual(body.tickets, kaya.claudeDesign.rates);
  });
});

test("an ended event with a public detail is marked past; current events are unchanged", async () => {
  await withUpstream(async () => {
    const ended = await get("7522");
    assert.equal(ended.status, 200);
    assert.equal(ended.body.isPast, true);
    assert.equal(ended.body.tickets.length, 1, "past rates stay as a record");

    for (const id of ["7479", "7480"]) {
      const current = await get(id);
      assert.equal(current.status, 200, id);
      assert.equal(current.body.isPast, false, `${id} keeps checkout`);
      assert.equal(current.body.checkoutEventId, Number(id));
    }
    const series = await get("7481");
    assert.equal(series.body.isPast, false, "a series keeps selling later dates");
    const tour = await get("6827");
    assert.equal(tour.body.isPast, false, "perennial tours never end");
  });
});

test("the draft id URL of a past project is read only too, and renders the same fields", async () => {
  await withUpstream(async (calls) => {
    const past = await get("draft-kaya", [kaya]);
    assert.equal(past.status, 200);
    assert.equal(past.body.isPast, true);
    assert.equal(past.body.startDate, null, "draft pages keep rendering without dates");
    assert.equal(past.body.endDate, null);
    const future = await get("draft-kaya", [project({ startDate: iso(now + 5 * DAY), endDate: iso(now + 6 * DAY) })]);
    assert.equal(future.body.isPast, false);
    const undated = await get("draft-kaya", [project({ startDate: "", endDate: "" })]);
    assert.equal(undated.body.isPast, false);
    assert.equal(calls.length, 0, "draft pages make no upstream calls");
  });
});

test("event.html never mounts checkout or the ticket CTA for a past event", () => {
  const html = readFileSync(new URL("../../event.html", import.meta.url), "utf8");
  const pastBranch = html.indexOf("if (isPast) {");
  const elseBranch = html.indexOf("} else {", pastBranch);
  const mount = html.indexOf("loadCheckout(\n", elseBranch);
  const definition = html.indexOf("function loadCheckout(");
  assert.ok(pastBranch > 0 && elseBranch > pastBranch && mount > elseBranch, "checkout is mounted only in the not past branch");
  assert.equal(html.indexOf("loadCheckout(\n"), mount, "there is no other checkout mount");
  assert.ok(definition > mount);
  assert.equal(html.slice(pastBranch, elseBranch).includes('$("book").hidden = false'), false);
  assert.match(html, /const isPast = ev\.isPast === true;/);
  assert.match(html, /isPast\s*\?\s*'<span class="ev-ended"[^']*>This event has ended<\/span>'\s*:\s*'<a class="btn-metal" href="#book">Get tickets →<\/a>'/);
});
