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

function kvWith(projects, docs = {}) {
  const byKey = new Map([...projects.map((p) => [`site-event:${p.id}`, p]), ...Object.entries(docs)]);
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

async function get(id, projects = [], headers = {}, docs = {}) {
  const env = { OVERRIDES: kvWith(projects, docs), OTRA_API_URL: "https://guide.test/api" };
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
  assert.equal(eventEndTime(start, start), Date.parse(start) + ENDED_GRACE_MS, "an end equal to the start gets the grace day");
  assert.equal(hasEnded(iso(now - 3600e3), iso(now - 3600e3)), false, "an event with end == start is still on an hour after it starts");
  assert.equal(hasEnded(iso(now - 2 * ENDED_GRACE_MS), iso(now - 2 * ENDED_GRACE_MS)), true);
  assert.equal(hasEnded(start, "2026-09-27T02:00:00-04:00", Date.parse("2026-09-27T01:00:00-04:00")), false);
});

test("a Guide 404 shows nothing on /api/event, whatever project is bound to it", async () => {
  await withUpstream(async () => {
    for (const [label, projects] of [
      ["the published past project", [kaya]],
      ["a future project", [project({ startDate: iso(now + 10 * DAY), endDate: iso(now + 10 * DAY + 8 * 3600e3) })]],
      ["an undated project", [project({ startDate: "", endDate: "" })]],
      ["an unpublished project", [project({ status: "draft" })]],
      ["no project at all", []],
    ]) {
      const { status, body, text } = await get("7567", projects);
      assert.equal(status, 404, label);
      assert.deepEqual(body, { error: "not found" }, label);
      assert.equal(/Kaya|Early Rooster|THE FESTIVAL/.test(text), false, `${label}: no content or rates`);
    }
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

// A draft bound to an ended Guide event whose detail is still public.
const bingoDraft = project({ id: "draft-bingo", otraGuideId: "7522", title: "Bingo Bengo", frozenSlug: "bingo-bengo-sep-6", startDate: "2026-09-06T17:00:00-04:00", endDate: "2026-09-06T20:00:00-04:00" });

test("an ended page whose checkout points at another event keeps its checkout", async () => {
  await withUpstream(async () => {
    // The admin "Checkout event ID" can send an old page to a newer edition
    // that is still on sale.
    const moved = await get("7522", [], {}, { "event:7522": { checkoutEventId: "7479" } });
    assert.equal(moved.status, 200);
    assert.equal(String(moved.body.checkoutEventId), "7479");
    assert.equal(moved.body.isPast, false);
    const same = await get("7522", [], {}, { "event:7522": { checkoutEventId: "7522" } });
    assert.equal(same.body.isPast, true, "pointing at itself changes nothing");
    const draft = await get("draft-bingo", [bingoDraft], {}, { "event:draft-bingo": { checkoutEventId: "7479" } });
    assert.equal(draft.body.isPast, false, "draft pages follow the same rule");
  });
});

test("the 8088 special case keeps checkout even when its project dates are past", async () => {
  await withUpstream(async () => {
    const p8088 = project({ id: "draft-1791253678425-26c548a5", otraGuideId: "8088", title: "8088", frozenSlug: "", startDate: "2026-10-12T18:00:00-04:00", endDate: "2026-10-12T23:00:00-04:00" });
    const { status, body, text } = await get("8088", [p8088]);
    assert.equal(status, 200);
    assert.equal(body.id, 8088);
    assert.equal(body.isPast, false);
    assert.ok(!/projectDates/.test(text));
  });
});

test("the draft id URL of an ended event with a public detail is read only, and renders the same fields", async () => {
  await withUpstream(async (calls) => {
    const past = await get("draft-bingo", [bingoDraft]);
    assert.equal(past.status, 200);
    assert.equal(past.body.isPast, true);
    assert.equal(past.body.startDate, null, "draft pages keep rendering without dates");
    assert.equal(past.body.endDate, null);
    const future = await get("draft-bingo", [project({ ...bingoDraft, startDate: iso(now + 5 * DAY), endDate: iso(now + 6 * DAY) })]);
    assert.equal(future.body.isPast, false);
    const undated = await get("draft-bingo", [project({ ...bingoDraft, startDate: "", endDate: "" })]);
    assert.equal(undated.body.isPast, false);
    assert.deepEqual(calls, Array(3).fill("/api/events/details/7522/"), "a bound draft only checks its Guide detail");
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
