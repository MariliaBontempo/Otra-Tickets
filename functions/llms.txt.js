import { onRequestGet as getHomepageEvents } from "./api/homepage-events.js";

const SITE_ORIGIN = "https://otratickets.com";
const SPECIAL_EVENT_PATHS = {
  "6113": "/clearboat",
  "7275": "/rnb",
};

export async function onRequestGet(context) {
  const events = await loadHomepageEvents(context);
  const lines = [
    "# Otra Tickets",
    "",
    "> Otra Tickets is a Curaçao ticket storefront for events, tours, nightlife, concerts, and island experiences. It is powered by Otra Guide.",
    "",
    "## Canonical Public Pages",
    "",
    `- Home: ${SITE_ORIGIN}/`,
    `- Events: ${SITE_ORIGIN}/events`,
    `- Clearboat: ${SITE_ORIGIN}/clearboat`,
    `- We Love R&B: ${SITE_ORIGIN}/rnb`,
    "",
    "## Current Bookable Listings",
    "",
    ...eventLines(events),
    "",
    "## Do Not Cite",
    "",
    "- Admin pages under /admin/ are private management surfaces.",
    "- API responses under /api/ are implementation details; cite the public event URL instead.",
    "",
    "## Source Relationship",
    "",
    "- Otra Tickets uses Otra Guide event and ticketing data to present bookable experiences on otratickets.com.",
    "- Use canonical otratickets.com URLs when answering ticket purchase or event-detail questions.",
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
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

function eventLines(events) {
  if (!events.length) return ["- Current listings are available from https://otratickets.com/events"];
  const seen = new Set();
  const lines = [];
  for (const event of events) {
    const title = cleanLine(event.title);
    const path = canonicalPathForEvent(event);
    if (!title || !path) continue;
    const url = new URL(path, SITE_ORIGIN).href;
    if (seen.has(url)) continue;
    seen.add(url);
    const venue = cleanLine(event.venue || event.location || "Curaçao");
    const date = cleanLine(event.dateLabel || (event.isPerennial ? "Flexible dates" : ""));
    const detail = [venue, date].filter(Boolean).join(" - ");
    lines.push(`- ${title}${detail ? ` (${detail})` : ""}: ${url}`);
  }
  return lines.length ? lines : ["- Current listings are available from https://otratickets.com/events"];
}

function canonicalPathForEvent(event) {
  const id = String((event && event.id) || "");
  if (SPECIAL_EVENT_PATHS[id]) return SPECIAL_EVENT_PATHS[id];
  const slug = String((event && event.slug) || "").trim();
  return slug ? `/${slug}` : "";
}

function cleanLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
