// Cloudflare Pages Function: GET /api/homepage-events
//
// Server-side proxy/aggregator for the homepage events track. The browser
// can't call otraguide.com directly (its CORS allowlist doesn't include
// otratickets.com), so this function fetches the non-perennial events feed
// for category 339 — including the "top shelf" perennial events the endpoint
// prepends (Clearboat, Iguana, ...) — keeps only events that actually have
// ticket types configured, sorts them, and returns a slim JSON list.
//
// Latency strategy (events change rarely, so favour serving fast over fresh):
//   * stale-while-revalidate — a cached copy is served instantly; once it is
//     older than FRESH_SECONDS it is still returned immediately while a fresh
//     build runs in the background. Only a completely cold cache waits.
//   * the upstream otraguide calls are themselves edge-cached (cf.cacheTtl),
//     so background rebuilds are cheap.
//   * feed pages are fetched in parallel rather than one after another.
//
// The feed-building logic lives in ../_lib/homepage-feed.js, shared with the
// staff-only admin preview endpoint (/admin/api/homepage-events). This public
// route never includes admin-only events, so its cached responses stay safe.

import { buildHomepageFeed, EDGE_TTL } from "../_lib/homepage-feed.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const forceFresh = url.searchParams.get("fresh") === "1";
  const { events, rows, hasSiteEvents } = await buildHomepageFeed(context, { forceFresh });
  return json({ events, rows }, 200, hasSiteEvents ? 0 : 120);
}

function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}, stale-while-revalidate=${EDGE_TTL}` : "no-store",
    },
  });
}
