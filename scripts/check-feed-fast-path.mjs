#!/usr/bin/env node
// Oracle: the public homepage feed answers from the KV snapshot without doing a
// foreground rebuild.
//
// Measured on production 2026-08-19: the snapshot path returned in 0.39s while
// the rebuild path took ~1.0s typical with spikes to 4.75s / 9.15s / 16.32s. A
// rebuild costs 2N+ sequential KV reads plus, on an upstream cache miss, live
// otraguide.com fetches. The snapshot costs one KV read.
//
// The trap this guards: serving a snapshot must NOT resurrect events the admin
// archived (functions/_lib/hidden-pages.js). The archived-page set is read
// alongside the snapshot and applied on the way out, so Archive stays instant
// even though the rest of the payload is one rebuild behind.
//
// Run: node scripts/check-feed-fast-path.mjs

import process from "node:process";

import { getPublicHomepageFeed } from "../functions/_lib/homepage-feed.js";
import { HIDDEN_PAGES_KEY } from "../functions/_lib/hidden-pages.js";

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const SNAPSHOT_KEY = "__homepage_feed_snapshot__";

const snapshotEvents = [
  { id: 101, title: "Kept Event", slug: "kept-event", date: "2999-01-01T20:00:00Z" },
  { id: 202, title: "Archived Event", slug: "archived-event", date: "2999-01-02T20:00:00Z" },
  { id: 303, title: "Also Kept", slug: "also-kept", date: "2999-01-03T20:00:00Z" },
];

function makeKv({ snapshot = true, hidden = ["202"] } = {}) {
  const reads = [];
  return {
    reads,
    async get(key, type) {
      void type;
      reads.push(key);
      if (key === SNAPSHOT_KEY) {
        return snapshot
          ? {
              events: snapshotEvents,
              rows: [
                { id: "main", title: "Featured", eventIds: ["101", "202", "303"] },
                { id: "archived-only", title: "Archived Only", eventIds: ["202"] },
              ],
              hasSiteEvents: true,
              generatedAt: Date.now(),
            }
          : null;
      }
      if (key === HIDDEN_PAGES_KEY) return hidden;
      return null;
    },
    async list() { return { keys: [], list_complete: true }; },
    async put() {},
  };
}

// A rebuild cannot finish without the upstream fetch. Hanging it forever means
// any foreground rebuild never resolves — so if the call below returns at all,
// it did not rebuild in the foreground.
const hangingFetch = () => new Promise(() => {});

globalThis.caches = {
  default: {
    async match() { return undefined; },
    async put() {},
  },
};

function makeContext(kv) {
  const background = [];
  return {
    context: {
      env: { OVERRIDES: kv },
      request: new Request("https://otratickets.com/api/homepage-events"),
      waitUntil: (promise) => {
        background.push(promise);
        if (promise && typeof promise.catch === "function") promise.catch(() => {});
      },
    },
    background,
  };
}

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);

// ---------------------------------------------------------------------------
// 1. Snapshot present -> answer without a foreground rebuild
// ---------------------------------------------------------------------------

globalThis.fetch = hangingFetch;

const kv = makeKv();
const { context, background } = makeContext(kv);

let feed = null;
try {
  feed = await withTimeout(
    getPublicHomepageFeed(context, {}),
    3000,
    "the feed did a FOREGROUND rebuild — it never answered from the snapshot",
  );
} catch (error) {
  failures.push(error.message);
}

if (feed) {
  assert(
    feed.feedSource === "kv-stale",
    `feedSource was "${feed.feedSource}", expected "kv-stale" (the snapshot fast path)`,
  );

  const ids = feed.events.map((event) => String(event.id));
  assert(ids.includes("101") && ids.includes("303"), `snapshot events missing, got [${ids}]`);

  // The whole point of the guard: archiving must not be undone by the snapshot.
  assert(
    !ids.includes("202"),
    "an admin-ARCHIVED event came back from the snapshot — this regresses hiding archived events",
  );

  // Rows must not advertise an event that is no longer in the payload.
  const rowIds = feed.rows.flatMap((row) => row.eventIds || []).map(String);
  assert(
    !rowIds.includes("202"),
    "a row still references the archived event id 202",
  );
  assert(
    !feed.rows.some((row) => !row.eventIds || row.eventIds.length === 0),
    "an empty row survived pruning",
  );

  // The snapshot must be refreshed behind the response, or it never updates.
  assert(background.length > 0, "no background rebuild was scheduled — the snapshot would go stale forever");

  // One read for the snapshot, one for the archived set. Not a rebuild's worth.
  assert(
    kv.reads.filter((key) => key === SNAPSHOT_KEY).length === 1,
    `snapshot was read ${kv.reads.filter((k) => k === SNAPSHOT_KEY).length} times, expected once`,
  );
  assert(
    kv.reads.includes(HIDDEN_PAGES_KEY),
    "the archived-page set was never read on the fast path",
  );
}

// ---------------------------------------------------------------------------
// 2. A warm edge probe must NOT outrank the snapshot
// ---------------------------------------------------------------------------
//
// This is the production symptom: every sampled request reported
// x-feed-source: edge, because the edge tier is checked first and rebuilds in
// the request path despite its "serve instantly" comment. With a usable
// snapshot the answer must come from the snapshot regardless of the probe.

globalThis.caches = {
  default: {
    async match() {
      return new Response(JSON.stringify({ events: [] }), {
        headers: { "content-type": "application/json", "x-generated-at": String(Date.now()) },
      });
    },
    async put() {},
  },
};
globalThis.fetch = hangingFetch;

const warmKv = makeKv();
const warm = makeContext(warmKv);
try {
  const warmFeed = await withTimeout(
    getPublicHomepageFeed(warm.context, {}),
    3000,
    "with a warm edge probe the feed rebuilt in the FOREGROUND instead of using the snapshot",
  );
  assert(
    warmFeed.feedSource === "kv-stale",
    `with a warm edge probe feedSource was "${warmFeed.feedSource}", expected "kv-stale" — the edge tier is still outranking the snapshot`,
  );
  assert(
    !warmFeed.events.map((event) => String(event.id)).includes("202"),
    "archived event returned on the warm-probe path",
  );
} catch (error) {
  failures.push(error.message);
}

globalThis.caches = {
  default: {
    async match() { return undefined; },
    async put() {},
  },
};

// ---------------------------------------------------------------------------
// 3. No snapshot -> must still build rather than serve nothing
// ---------------------------------------------------------------------------

globalThis.fetch = async () =>
  new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } });

const coldKv = makeKv({ snapshot: false });
const cold = makeContext(coldKv);
try {
  const coldFeed = await withTimeout(
    getPublicHomepageFeed(cold.context, {}),
    10000,
    "cold path (no snapshot) never resolved",
  );
  assert(
    coldFeed.feedSource === "origin",
    `cold feedSource was "${coldFeed.feedSource}", expected "origin"`,
  );
  assert(Array.isArray(coldFeed.events), "cold path did not return an events array");
} catch (error) {
  failures.push(error.message);
}

// ---------------------------------------------------------------------------

if (failures.length) {
  for (const failure of failures) console.error("FAIL " + failure);
  console.error(`\nfeed-fast-path: ${failures.length} failure(s)`);
  process.exit(1);
}

console.log("PASS feed-fast-path: snapshot answers without a foreground rebuild, archived events stay hidden");
