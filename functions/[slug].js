import { eventSlug } from "./_lib/event-slug.js";
import { onRequestGet as getHomepageEvents } from "./api/homepage-events.js";

const STATIC_PATHS = new Set([
  "admin",
  "clearboat",
  "event",
  "events",
  "index",
  "rnb",
]);

const SPECIAL_EVENT_ASSETS = {
  "6113": "/clearboat",
  "7275": "/rnb",
};

export async function onRequestGet(context) {
  const slug = String(context.params.slug || "").toLowerCase();
  if (!isEventSlug(slug) || STATIC_PATHS.has(slug)) {
    return context.env.ASSETS.fetch(context.request);
  }

  const feedUrl = new URL("/api/homepage-events", context.request.url);
  const feedResponse = await getHomepageEvents({ ...context, request: new Request(feedUrl) });
  if (!feedResponse.ok) return notFound();

  const feed = await feedResponse.json().catch(() => null);
  const event = Array.isArray(feed && feed.events)
    ? feed.events.find((item) => item && item.slug === slug)
    : null;
  if (!event) return notFound();

  const id = String(event.id || "");
  const assetPath = SPECIAL_EVENT_ASSETS[id] || "/event";
  const assetResponse = await context.env.ASSETS.fetch(new URL(assetPath, context.request.url));
  if (!assetResponse.ok || assetPath !== "/event") return assetResponse;

  const html = await assetResponse.text();
  const body = html
    .replace('data-event-id=""', `data-event-id="${escapeAttribute(id)}"`)
    .replace('src="site-overrides.js?v=4"', `src="site-overrides.js?v=4" data-override-id="${escapeAttribute(id)}"`);
  const headers = new Headers(assetResponse.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "public, max-age=60");
  headers.set("link", `</${slug}>; rel="canonical"`);
  return new Response(body, { status: assetResponse.status, headers });
}

function isEventSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && !value.includes(".");
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export { eventSlug };
