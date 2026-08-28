#!/usr/bin/env node
// Oracle: freeze first. Alias is a safety net only when the homepage feed is healthy.
//
// Production still serves the pre-rename Iguana Ride E-Scooter pretty URLs.
// Bound cards keep those frozen slugs, so those paths 200 while the live
// event is in the feed. The alias 301 to the Django title slug is only for
// a genuine miss on a healthy feed (ok response, non empty events array).
// An empty or failed feed must 404, never 301 to a slug that 404s in production.
//
// Run: node scripts/check-slug-aliases.mjs

import process from "node:process";

import { onRequestGet as slugRoute } from "../functions/[slug].js";
import { eventSlug } from "../functions/_lib/event-slug.js";
import { SLUG_ALIASES, SLUG_ALIAS_TITLES } from "../functions/_lib/slug-aliases.js";

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const GOLDEN = [
  ["iguana-ride-e-scooter-city-combo-tour", "Iguana Scooter Ride - City Combo Tour"],
  ["iguana-ride-e-scooter-punda-or-otrobanda-tour", "Iguana Scooter Ride - Punda or Otrobanda Tour"],
  ["iguana-ride-e-scooter-night-tour", "Iguana Scooter Ride - Night Tour"],
  ["iguana-ride-e-scooter-sunset-tour", "Iguana Scooter Ride - Sunset Tour"],
];

const FOUR_EVENTS = GOLDEN.map(([slug, title], i) => ({
  id: String(6827 + i),
  slug,
  title,
}));

const EVENT_HTML = `<!doctype html><html><head><title>Event</title></head><body><div data-event-id=""></div><script src="/site-overrides.js"></script></body></html>`;

function jsonFeed(body, status = 200) {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function throwingFeed() {
  return async () => {
    throw new Error("homepage feed failed");
  };
}

function eventAssets() {
  return {
    fetch: async () => new Response(EVENT_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  };
}

function explodingAssets() {
  return {
    fetch: () => {
      throw new Error("ASSETS.fetch reached");
    },
  };
}

async function callSlug(slug, { getHomepageEvents, assets } = {}) {
  return slugRoute({
    getHomepageEvents,
    env: {
      ASSETS: assets || explodingAssets(),
      OVERRIDES: {
        get: () => {
          throw new Error("KV reached");
        },
      },
    },
    params: { slug },
    request: new Request(`https://otratickets.com/${slug}`),
  });
}

assert(
  SLUG_ALIAS_TITLES.length === GOLDEN.length,
  `SLUG_ALIAS_TITLES has ${SLUG_ALIAS_TITLES.length} entries, expected ${GOLDEN.length}`,
);

for (const [from, title] of GOLDEN) {
  const expected = `/${eventSlug(title)}`;
  assert(
    SLUG_ALIASES.get(from) === expected,
    `SLUG_ALIASES[${from}] is ${SLUG_ALIASES.get(from)}, expected ${expected}`,
  );
  assert(
    expected !== "/",
    `${from} must alias to the new event slug, not /`,
  );
}

assert(
  !SLUG_ALIASES.has("events") && !SLUG_ALIASES.has("events.html"),
  "SLUG_ALIASES must not swallow the retired /events redirect to /",
);

for (const [from, title] of GOLDEN) {
  const expected = `/${eventSlug(title)}`;

  let threwResponse;
  try {
    threwResponse = await callSlug(from, { getHomepageEvents: throwingFeed() });
  } catch (error) {
    failures.push(`/${from} threw on a failed feed: ${error.message}`);
    threwResponse = null;
  }
  if (threwResponse) {
    assert(threwResponse.status === 404, `/${from} on a throwing feed returned ${threwResponse.status}, expected 404`);
    assert(
      String(threwResponse.headers.get("cache-control") || "").includes("no-store"),
      `/${from} on a throwing feed must not cache (got ${threwResponse.headers.get("cache-control")})`,
    );
  }

  let emptyResponse;
  try {
    emptyResponse = await callSlug(from, { getHomepageEvents: jsonFeed({ events: [] }) });
  } catch (error) {
    failures.push(`/${from} threw on an empty feed: ${error.message}`);
    emptyResponse = null;
  }
  if (emptyResponse) {
    assert(emptyResponse.status === 404, `/${from} on an empty feed returned ${emptyResponse.status}, expected 404`);
    assert(
      String(emptyResponse.headers.get("cache-control") || "").includes("no-store"),
      `/${from} on an empty feed must not cache (got ${emptyResponse.headers.get("cache-control")})`,
    );
  }

  let failedStatusResponse;
  try {
    failedStatusResponse = await callSlug(from, { getHomepageEvents: jsonFeed({ events: FOUR_EVENTS }, 500) });
  } catch (error) {
    failures.push(`/${from} threw on a non-ok feed: ${error.message}`);
    failedStatusResponse = null;
  }
  if (failedStatusResponse) {
    assert(failedStatusResponse.status === 404, `/${from} on a non-ok feed returned ${failedStatusResponse.status}, expected 404`);
    assert(
      !failedStatusResponse.headers.get("location"),
      `/${from} on a non-ok feed must not redirect (got ${failedStatusResponse.headers.get("location")})`,
    );
  }

  let missingEventsResponse;
  try {
    missingEventsResponse = await callSlug(from, { getHomepageEvents: jsonFeed({}) });
  } catch (error) {
    failures.push(`/${from} threw when the feed omitted events: ${error.message}`);
    missingEventsResponse = null;
  }
  if (missingEventsResponse) {
    assert(missingEventsResponse.status === 404, `/${from} on a feed without events returned ${missingEventsResponse.status}, expected 404`);
  }

  let presentResponse;
  try {
    presentResponse = await callSlug(from, {
      getHomepageEvents: jsonFeed({ events: FOUR_EVENTS }),
      assets: eventAssets(),
    });
  } catch (error) {
    failures.push(`/${from} threw when the healthy feed listed the slug: ${error.message}`);
    presentResponse = null;
  }
  if (presentResponse) {
    assert(presentResponse.status === 200, `/${from} on a healthy feed with the slug present returned ${presentResponse.status}, expected 200`);
    assert(
      !presentResponse.headers.get("location"),
      `/${from} on a healthy feed with the slug present must not redirect (got ${presentResponse.headers.get("location")})`,
    );
  }

  let missingResponse;
  try {
    missingResponse = await callSlug(from, {
      getHomepageEvents: jsonFeed({
        events: [{ id: "1", slug: "some-other-event", title: "Other Event" }],
      }),
    });
  } catch (error) {
    failures.push(`/${from} threw when the healthy feed omitted the slug: ${error.message}`);
    missingResponse = null;
  }
  if (missingResponse) {
    assert(missingResponse.status === 301, `/${from} on a healthy miss returned ${missingResponse.status}, expected 301`);
    assert(
      missingResponse.headers.get("location") === expected,
      `/${from} on a healthy miss redirects to ${missingResponse.headers.get("location")}, expected ${expected}`,
    );
  }
}

// /events stays on the retired-path map, not the alias map, and still 301s
// home even when the feed would throw.
let eventsResponse;
try {
  eventsResponse = await callSlug("events");
} catch (error) {
  failures.push(`/events did not short-circuit as a retired path: ${error.message}`);
  eventsResponse = null;
}
if (eventsResponse) {
  assert(eventsResponse.status === 301, `/events returned ${eventsResponse.status}, expected a 301`);
  assert(
    eventsResponse.headers.get("location") === "/",
    `/events redirects to ${eventsResponse.headers.get("location")}, expected /`,
  );
}

if (failures.length) {
  for (const failure of failures) console.error("FAIL " + failure);
  console.error(`\nslug-aliases: ${failures.length} failure(s)`);
  process.exit(1);
}

console.log("PASS slug-aliases: freeze 200 on a healthy feed, 301 only on a healthy miss, 404 when the feed is empty or failed");
