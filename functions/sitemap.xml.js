import { onRequestGet as getHomepageEvents } from "./api/homepage-events.js";

const SITE_ORIGIN = "https://otratickets.com";
const SPECIAL_EVENT_PATHS = {
  "6113": "/clearboat",
  "7275": "/rnb",
};

const STATIC_URLS = [
  { path: "/", changefreq: "daily", priority: "1.0" },
  { path: "/events", changefreq: "daily", priority: "0.9" },
  { path: "/clearboat", changefreq: "weekly", priority: "0.8" },
  { path: "/rnb", changefreq: "weekly", priority: "0.8" },
];

export async function onRequestGet(context) {
  const urls = new Map();
  for (const item of STATIC_URLS) addUrl(urls, item);

  const events = await loadHomepageEvents(context);
  for (const event of events) {
    const canonicalPath = canonicalPathForEvent(event);
    if (!canonicalPath) continue;
    const parsedDate = event.date ? new Date(event.date) : null;
    const lastmod = parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toISOString().slice(0, 10)
      : "";
    addUrl(urls, {
      path: canonicalPath,
      lastmod,
      changefreq: event.isPerennial ? "weekly" : "daily",
      priority: event.isPerennial ? "0.7" : "0.8",
    });
  }

  return new Response(renderSitemap([...urls.values()]), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}

async function loadHomepageEvents(context) {
  try {
    const feedUrl = new URL("/api/homepage-events", context.request.url);
    const response = await getHomepageEvents({ ...context, request: new Request(feedUrl) });
    if (!response.ok) return [];
    const feed = await response.json();
    return Array.isArray(feed && feed.events) ? feed.events : [];
  } catch {
    return [];
  }
}

function canonicalPathForEvent(event) {
  const id = String((event && event.id) || "");
  if (SPECIAL_EVENT_PATHS[id]) return SPECIAL_EVENT_PATHS[id];
  const slug = String((event && event.slug) || "").trim();
  return slug ? `/${slug}` : "";
}

function addUrl(urls, item) {
  const loc = new URL(item.path, SITE_ORIGIN).href;
  if (urls.has(loc)) return;
  urls.set(loc, { ...item, loc });
}

function renderSitemap(items) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...items.map((item) => [
      "  <url>",
      `    <loc>${escapeXml(item.loc)}</loc>`,
      item.lastmod ? `    <lastmod>${escapeXml(item.lastmod)}</lastmod>` : "",
      item.changefreq ? `    <changefreq>${escapeXml(item.changefreq)}</changefreq>` : "",
      item.priority ? `    <priority>${escapeXml(item.priority)}</priority>` : "",
      "  </url>",
    ].filter(Boolean).join("\n")),
    "</urlset>",
    "",
  ].join("\n");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
