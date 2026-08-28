#!/usr/bin/env node
// Oracle: old Iguana pretty URLs 301 to the live event-page slugs.
//
// Production still serves the pre-rename paths (Iguana Ride [E-Scooter] ...).
// After bound cards slug from the live Django title those paths would 404
// unless aliased. The alias branch must answer before any feed/KV lookup.
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
    `${from} must 301 to the new event slug, not /`,
  );
}

assert(
  !SLUG_ALIASES.has("events") && !SLUG_ALIASES.has("events.html"),
  "SLUG_ALIASES must not swallow the retired /events → / redirect",
);

// The alias branch must answer before any feed lookup, so a context whose
// feed access would throw is exactly the right probe.
const explodingContext = {
  env: {
    ASSETS: { fetch: () => { throw new Error("ASSETS.fetch reached for an aliased path"); } },
    OVERRIDES: { get: () => { throw new Error("KV reached for an aliased path"); } },
  },
};

for (const [from, title] of GOLDEN) {
  const expected = `/${eventSlug(title)}`;
  let response;
  try {
    response = await slugRoute({
      ...explodingContext,
      params: { slug: from },
      request: new Request(`https://otratickets.com/${from}`),
    });
  } catch (error) {
    failures.push(`/${from} did not short-circuit as an alias: ${error.message}`);
    continue;
  }
  assert(response.status === 301, `/${from} returned ${response.status}, expected a 301`);
  assert(
    response.headers.get("location") === expected,
    `/${from} redirects to ${response.headers.get("location")}, expected ${expected}`,
  );
}

// /events stays on the retired-path map, not the alias map.
let eventsResponse;
try {
  eventsResponse = await slugRoute({
    ...explodingContext,
    params: { slug: "events" },
    request: new Request("https://otratickets.com/events"),
  });
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

console.log("PASS slug-aliases: old Iguana slugs 301 to the live Django slugs before feed/KV");
