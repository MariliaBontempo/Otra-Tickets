#!/usr/bin/env node
// Oracle: the /events browse page is retired.
//
// It rendered a hardcoded demo array instead of the live /api/homepage-events
// feed, so it showed expired placeholder events behind ~32 dead href="#" links.
// The Otra Tickets logo on /clearboat pointed at it, which is how real users
// reached it. Retiring means: the page is gone, /events and /events.html 301 to
// the homepage, nothing on the site or in the machine-readable surfaces points
// at it any more, and the logo on every page is a working link home.
//
// Run: node scripts/check-events-retired.mjs

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { onRequestGet as slugRoute } from "../functions/[slug].js";
import { onRequestGet as sitemapRoute } from "../functions/sitemap.xml.js";
import { onRequestGet as llmsRoute } from "../functions/llms.txt.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const PUBLIC_PAGES = ["index.html", "clearboat.html", "rnb.html", "event.html"];

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

// The retired-path branch must answer before any feed lookup, so a context whose
// feed access would throw is exactly the right probe.
const explodingContext = {
  env: {
    ASSETS: { fetch: () => { throw new Error("ASSETS.fetch reached for a retired path"); } },
    OVERRIDES: { get: () => { throw new Error("KV reached for a retired path"); } },
  },
};

// ---------------------------------------------------------------------------
// 1. The page itself is gone
// ---------------------------------------------------------------------------

assert(!existsSync(join(REPO_ROOT, "events.html")), "events.html still exists in the repo root");

// ---------------------------------------------------------------------------
// 2. /events and /events.html redirect home, permanently
// ---------------------------------------------------------------------------

for (const path of ["events", "events.html", "EVENTS"]) {
  let response;
  try {
    response = await slugRoute({
      ...explodingContext,
      params: { slug: path },
      request: new Request(`https://otratickets.com/${path}`),
    });
  } catch (error) {
    failures.push(`/${path} did not short-circuit as a retired path: ${error.message}`);
    continue;
  }
  assert(response.status === 301, `/${path} returned ${response.status}, expected a 301`);
  assert(
    response.headers.get("location") === "/",
    `/${path} redirects to ${response.headers.get("location")}, expected /`,
  );
}

// Other single-segment paths must NOT get swept up by the redirect: they still
// go to the static asset store (or on to the event lookup).
let clearboatReachedAssets = false;
await slugRoute({
  env: {
    ASSETS: {
      fetch: () => {
        clearboatReachedAssets = true;
        return new Response("ok", { status: 200 });
      },
    },
  },
  params: { slug: "clearboat" },
  request: new Request("https://otratickets.com/clearboat"),
}).catch((error) => failures.push(`/clearboat route threw: ${error.message}`));
assert(clearboatReachedAssets, "/clearboat no longer reaches the static asset store");

// ---------------------------------------------------------------------------
// 3. Nothing on the site links to the retired page
// ---------------------------------------------------------------------------

for (const page of PUBLIC_PAGES) {
  const html = readFileSync(join(REPO_ROOT, page), "utf8");
  assert(!/href="[^"]*events\.html"/i.test(html), `${page} still links to events.html`);
  assert(!/href="\/events"/i.test(html), `${page} still links to /events`);
}

// ---------------------------------------------------------------------------
// 4. The logo is a working link home on every page
// ---------------------------------------------------------------------------

for (const page of PUBLIC_PAGES) {
  const html = readFileSync(join(REPO_ROOT, page), "utf8");
  const brand = html.match(/<(\w+)[^>]*class="brand"[^>]*>/i);
  assert(brand !== null, `${page} has no .brand element`);
  if (!brand) continue;
  assert(
    brand[1].toLowerCase() === "a",
    `${page} renders .brand as <${brand[1]}>, so the logo is not clickable`,
  );
  const href = brand[0].match(/href="([^"]*)"/i);
  assert(
    href !== null && (href[1] === "/" || href[1] === "index.html"),
    `${page} .brand href is ${href ? href[1] : "missing"}, expected the homepage`,
  );
}

// ---------------------------------------------------------------------------
// 5. Machine-readable surfaces no longer advertise /events
// ---------------------------------------------------------------------------

const feedlessContext = {
  env: {},
  request: new Request("https://otratickets.com/sitemap.xml"),
};

const sitemap = await sitemapRoute(feedlessContext).then((r) => r.text());
assert(
  !/<loc>https:\/\/otratickets\.com\/events<\/loc>/.test(sitemap),
  "sitemap.xml still lists https://otratickets.com/events",
);
assert(
  /<loc>https:\/\/otratickets\.com\/<\/loc>/.test(sitemap),
  "sitemap.xml no longer lists the homepage",
);

const llms = await llmsRoute({
  env: {},
  request: new Request("https://otratickets.com/llms.txt"),
}).then((r) => r.text());
assert(
  !/otratickets\.com\/events\b/.test(llms),
  "llms.txt still points answer engines at /events",
);

// Rendering only exercises the branch the current feed happens to take, so also
// check the source: an empty-feed fallback string can keep the dead URL alive.
const SOURCES = [
  "functions/sitemap.xml.js",
  "functions/llms.txt.js",
  "scripts/build-pages.mjs",
];
for (const source of SOURCES) {
  const text = readFileSync(join(REPO_ROOT, source), "utf8");
  assert(
    !/otratickets\.com\/events\b/.test(text),
    `${source} still hardcodes https://otratickets.com/events`,
  );
  assert(
    !/["']events\.html["']/.test(text),
    `${source} still references events.html`,
  );
}

// ---------------------------------------------------------------------------

if (failures.length) {
  for (const failure of failures) console.error("FAIL " + failure);
  console.error(`\nevents-retired: ${failures.length} failure(s)`);
  process.exit(1);
}

console.log("PASS events-retired: /events is gone, redirects home, and nothing links to it");
