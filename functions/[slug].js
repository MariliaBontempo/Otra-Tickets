import { eventSlug } from "./_lib/event-slug.js";
import { SLUG_ALIASES } from "./_lib/slug-aliases.js";
import { onRequestGet as getHomepageEvents } from "./api/homepage-events.js";

const STATIC_PATHS = new Set([
  "admin",
  "clearboat",
  "event",
  "index",
  "rnb",
]);

// Retired pages: paths that used to serve an asset and now permanently redirect.
// /events was a browse page built from a hardcoded demo array rather than the
// live feed, so it showed expired placeholder events behind dead links. The
// homepage already renders the same category rows from /api/homepage-events.
const RETIRED_PATHS = new Map([
  ["events", "/"],
  ["events.html", "/"],
]);

const SPECIAL_EVENT_ASSETS = {
  "6113": "/clearboat",
  "7275": "/rnb",
};
const SITE_ORIGIN = "https://otratickets.com";
const SITE_NAME = "Otra Tickets";

export async function onRequestGet(context) {
  const slug = String(context.params.slug || "").toLowerCase();
  const retiredTarget = RETIRED_PATHS.get(slug);
  if (retiredTarget) return permanentRedirect(retiredTarget);
  const aliasTarget = SLUG_ALIASES.get(slug);
  if (!isEventSlug(slug) || STATIC_PATHS.has(slug)) {
    if (aliasTarget) return permanentRedirect(aliasTarget);
    return context.env.ASSETS.fetch(context.request);
  }

  // Frozen live slugs (iguana-ride-e-scooter-...) must 200 when the feed
  // still lists them, even if an alias also lists that path. The 301 is
  // only a safety net when the feed is healthy, this slug is genuinely
  // missing, AND the alias target is present in that same events list.
  // Never 301 to a slug the current feed would 404. Empty or failed
  // feed returns 404 no-store.
  let event = null;
  let feedHealthy = false;
  let aliasTargetPresent = false;
  try {
    const feedUrl = new URL("/api/homepage-events", context.request.url);
    const fetchFeed = typeof context.getHomepageEvents === "function"
      ? context.getHomepageEvents
      : getHomepageEvents;
    const feedResponse = await fetchFeed({ ...context, request: new Request(feedUrl) });
    if (feedResponse.ok) {
      const feed = await feedResponse.json().catch(() => null);
      const events = feed && Array.isArray(feed.events) ? feed.events : null;
      feedHealthy = Boolean(events && events.length);
      event = feedHealthy
        ? events.find((item) => item && item.slug === slug) || null
        : null;
      const targetSlug = aliasTarget ? String(aliasTarget).replace(/^\//, "") : "";
      aliasTargetPresent = Boolean(
        feedHealthy &&
        targetSlug &&
        events.some((item) => item && item.slug === targetSlug)
      );
    }
  } catch {
    event = null;
    feedHealthy = false;
    aliasTargetPresent = false;
  }
  if (event) {
    // serve below
  } else if (feedHealthy && aliasTarget && aliasTargetPresent) {
    return permanentRedirect(aliasTarget);
  } else {
    return notFound();
  }

  const id = String(event.id || "");
  const assetPath = SPECIAL_EVENT_ASSETS[id] || "/event";
  const assetResponse = await context.env.ASSETS.fetch(new URL(assetPath, context.request.url));
  if (!assetResponse.ok || assetPath !== "/event") return assetResponse;

  const html = await assetResponse.text();
  const body = injectEventHead(
    injectOverrideId(
      html.replace('data-event-id=""', `data-event-id="${escapeAttribute(id)}"`),
      id,
    ),
    event,
    context.request.url,
  );
  const headers = new Headers(assetResponse.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "public, max-age=60");
  headers.set("link", `</${slug}>; rel="canonical"`);
  return new Response(body, { status: assetResponse.status, headers });
}

export function injectOverrideId(html, id) {
  return html.replace(
    /<script\b([^>]*\bsrc=["']\/site-overrides\.js(?:\?[^"']*)?["'][^>]*)>/i,
    (tag, attributes) => {
      if (/\bdata-override-id\s*=/.test(attributes)) return tag;
      return `<script${attributes} data-override-id="${escapeAttribute(String(id || ""))}">`;
    },
  );
}

function injectEventHead(html, event, requestUrl) {
  const seo = eventSeo(event, requestUrl);
  const jsonLd = safeJson({
    "@context": "https://schema.org",
    "@type": "Event",
    name: seo.eventTitle,
    description: seo.description,
    url: seo.canonical,
    image: seo.image ? [seo.image] : undefined,
    startDate: event.date || undefined,
    endDate: event.endDate || undefined,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: seo.venue ? {
      "@type": "Place",
      name: seo.venue,
      address: {
        "@type": "PostalAddress",
        addressLocality: "Curaçao",
        addressCountry: "CW",
      },
    } : undefined,
    organizer: {
      "@type": "Organization",
      name: SITE_NAME,
      url: SITE_ORIGIN,
    },
    offers: {
      "@type": "Offer",
      url: seo.canonical,
      availability: "https://schema.org/InStock",
    },
  });

  const injectedHead = [
    `<title>${escapeHtml(seo.title)}</title>`,
    `<meta name="description" content="${escapeAttribute(seo.description)}" />`,
    `<link rel="canonical" href="${escapeAttribute(seo.canonical)}" />`,
    `<meta property="og:type" content="event" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${escapeAttribute(seo.title)}" />`,
    `<meta property="og:description" content="${escapeAttribute(seo.description)}" />`,
    `<meta property="og:url" content="${escapeAttribute(seo.canonical)}" />`,
    seo.image ? `<meta property="og:image" content="${escapeAttribute(seo.image)}" />` : "",
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeAttribute(seo.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttribute(seo.description)}" />`,
    seo.image ? `<meta name="twitter:image" content="${escapeAttribute(seo.image)}" />` : "",
    `<script type="application/ld+json">${jsonLd}</script>`,
  ].filter(Boolean).join("\n");

  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, injectedHead);
  }
  return html.replace(/<head[^>]*>/i, (match) => `${match}\n${injectedHead}`);
}

function eventSeo(event, requestUrl) {
  const eventTitle = cleanText(event.title) || "Otra Tickets Event";
  const venue = cleanText(event.venue || event.location || "Curaçao");
  const date = cleanText(event.dateLabel || (event.isPerennial ? "Flexible dates" : ""));
  const slug = cleanText(event.slug);
  const canonical = new URL(slug ? `/${slug}` : "/", SITE_ORIGIN).href;
  const image = event.img ? absoluteUrl(event.img, requestUrl) : "";
  const when = date ? ` on ${date}` : "";
  const where = venue ? ` at ${venue}` : " in Curaçao";
  const description = clampDescription(`Get tickets for ${eventTitle}${when}${where} through Otra Tickets, powered by Otra Guide.`);
  return {
    eventTitle,
    title: `${eventTitle} Tickets | ${SITE_NAME}`,
    description,
    canonical,
    image,
    venue,
  };
}

function isEventSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && !value.includes(".");
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(value) {
  return escapeAttribute(value).replace(/'/g, "&#39;");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampDescription(value) {
  const text = cleanText(value);
  if (text.length <= 160) return text;
  return text.slice(0, 157).replace(/\s+\S*$/, "") + "...";
}

function absoluteUrl(value, requestUrl) {
  try {
    return new URL(String(value || ""), requestUrl).href;
  } catch {
    return "";
  }
}

function safeJson(value) {
  return JSON.stringify(prune(value)).replace(/<\/script/gi, "<\\/script");
}

function prune(value) {
  if (Array.isArray(value)) return value.map(prune).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const next = prune(item);
      if (next !== undefined && next !== "") out[key] = next;
    }
    return out;
  }
  return value === undefined || value === null || value === "" ? undefined : value;
}

function permanentRedirect(location) {
  return new Response(null, {
    status: 301,
    headers: { location, "cache-control": "public, max-age=3600" },
  });
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export { eventSlug };
