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

const API = "https://otraguide.com/api";
const CATEGORY_ID = 339;
// We Love R&B is the headliner: it always leads the homepage row.
const FEATURED_ID = 7275;
// Event ids to keep off the homepage even if they pass the ticket filter.
const EXCLUDED_IDS = new Set([7012]); // Sinusta Tours & Transfers
const LOCAL_MAIN_IMAGES = {
  "7275": "uploads/We Love R&B July 4th TJ-5.webp",
  "6113": "uploads/Clearboat Hero.webp",
};
const LOCAL_CARD_INFO = {
  "6194": { venue: "Daaibooi Beach", dateLabel: "Fri & Sat · 5PM" },
  "7275": { venue: "Cascada Rooftop", dateLabel: "Saturday July 4 · 6PM" },
  "6113": { venue: "Daaibooi Beach", dateLabel: "Daily · 10AM" },
  "7176": { venue: "Barber Westpunt", dateLabel: "Daily" },
  "6827": { venue: "Pietermaai", dateLabel: "Daily" },
  "7359": { venue: "Curaçao", dateLabel: "Sunday July 5 · 5PM" },
};
const PAGE_SIZE = 20;
const MAX_PAGES = 8;
// Pages fetched together in the first parallel round (covers the usual feed
// size in one hop; more are fetched only if the feed is larger).
const PROBE_PAGES = 4;
// Workers allow 50 subrequests per request; feed pages + ticket checks must
// stay under that, so cap the ticket-type lookups.
const MAX_TICKET_CHECKS = 40;
// How long a cached build is considered fresh. Past this it is still served
// instantly (stale) while a background refresh runs.
const FRESH_SECONDS = 600;
// How long the edge keeps the cached build available for stale-while-
// revalidate. Must be long so caches.default never drops it from under us.
const EDGE_TTL = 86400;
// Edge-cache the upstream otraguide responses to speed up rebuilds.
const UPSTREAM_TTL = 300;
const HOMEPAGE_TIME_ZONE = "America/Curacao";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const forceFresh = url.searchParams.get("fresh") === "1";
  const now = Date.now();
  const [siteEvents, upstreamEvents] = await Promise.all([
    buildPublishedSiteEvents(context.env),
    getUpstreamEvents(context, now, forceFresh),
  ]);
  const visibleEvents = [...siteEvents, ...upstreamEvents].filter((event) => isCurrentOrFutureEvent(event, now));
  const events = await applyImageOverrides(visibleEvents, context.env);
  const rows = await buildRows(events, context.env);
  return json({ events, rows }, 200, siteEvents.length ? 0 : 120);
}

async function getUpstreamEvents(context, now, forceFresh) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/homepage-upstream-events", context.request.url));
  const cached = await cache.match(cacheKey);
  if (cached && !forceFresh) {
    const generatedAt = Number(cached.headers.get("x-generated-at")) || 0;
    const ageSeconds = (now - generatedAt) / 1000;
    if (ageSeconds >= FRESH_SECONDS) {
      context.waitUntil(storeUpstreamEvents(cache, cacheKey, now));
    }
    try {
      const payload = await cached.json();
      return Array.isArray(payload.events) ? payload.events : [];
    } catch {
      return [];
    }
  }

  const stored = await storeUpstreamEvents(cache, cacheKey, now);
  try {
    const payload = await stored.json();
    return Array.isArray(payload.events) ? payload.events : [];
  } catch {
    return [];
  }
}

async function storeUpstreamEvents(cache, cacheKey, now) {
  const events = await buildEvents();
  const body = JSON.stringify({ events });
  const stored = new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${EDGE_TTL}`,
      "x-generated-at": String(now),
    },
  });
  await cache.put(cacheKey, stored.clone());
  return stored;
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

async function buildRows(events, env) {
  const ids = events.map((ev) => String(ev.id));
  const existing = new Set(ids);
  const fallback = [{ id: "main", title: "", eventIds: ids }];
  const kv = env && env.OVERRIDES;
  if (!kv) return fallback;

  let layout;
  try {
    layout = await kv.get("homepage:layout", "json");
  } catch {
    layout = null;
  }
  const rows = normalizeRows(layout && layout.rows, existing);
  if (!rows.length) return fallback;

  const assigned = new Set(rows.flatMap((row) => row.eventIds));
  const missing = ids.filter((id) => !assigned.has(id));
  if (missing.length) rows[0].eventIds.push(...missing);
  return rows.filter((row) => row.eventIds.length);
}

function normalizeRows(raw, existing) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row, i) => {
      const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `row-${i + 1}`;
      const title = typeof row.title === "string" ? row.title.trim().slice(0, 80) : "";
      const eventIds = Array.isArray(row.eventIds)
        ? [...new Set(row.eventIds.map((value) => String(value)).filter((id) => existing.has(id)))]
        : [];
      return { id, title, eventIds };
    })
    .filter((row) => row.eventIds.length);
}

async function buildPublishedSiteEvents(env) {
  const kv = env && env.OVERRIDES;
  if (!kv) return [];

  const out = [];
  let cursor;
  do {
    let page;
    try {
      page = await kv.list({ prefix: "site-event:", cursor });
    } catch {
      return out;
    }
    for (const key of page.keys || []) {
      let project;
      try {
        project = await kv.get(key.name, "json");
      } catch {
        project = null;
      }
      if (!project || typeof project !== "object" || project.status !== "published") continue;
      const draftId = key.name.replace(/^site-event:/, "");
      const id = project.otraGuideId ? String(project.otraGuideId) : draftId;
      const localCard = LOCAL_CARD_INFO[id];
      const startDate = validDateValue(project.startDate);
      const endDate = validDateValue(project.endDate);
      out.push({
        id,
        title: typeof project.title === "string" && project.title.trim() ? project.title.trim() : "Claude Design Event",
        date: startDate,
        endDate,
        isPerennial: project.isPerennial === true,
        venue: (localCard && localCard.venue) || projectVenue(project),
        dateLabel: (localCard && localCard.dateLabel) || projectDateLabel(project),
        img:
          (typeof project.image === "string" && project.image) ||
          (project.claudeDesign && typeof project.claudeDesign.image === "string" && project.claudeDesign.image) ||
          "",
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

async function fetchJson(url) {
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function feedUrl(page) {
  return `${API}/events/nonperennial/?category_id=${CATEGORY_ID}&page=${page}&page_size=${PAGE_SIZE}`;
}

async function buildEvents() {
  // Fetch the first few pages in one parallel round (the dataset is small, so
  // this usually covers it) instead of waiting on page 1 to learn the count.
  // Only if the feed turns out to be larger do we fetch the remaining pages.
  const probe = Math.min(MAX_PAGES, PROBE_PAGES);
  const firstBatch = await Promise.all(
    Array.from({ length: probe }, (_, i) => fetchJson(feedUrl(i + 1)))
  );
  if (!firstBatch[0]) return [];

  const results = [];
  for (const data of firstBatch) {
    if (data && data.results) results.push(...data.results);
  }
  const count = firstBatch[0].count || results.length;
  const totalPages = Math.min(MAX_PAGES, Math.ceil(count / PAGE_SIZE));
  if (totalPages > probe) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - probe }, (_, i) => fetchJson(feedUrl(probe + i + 1)))
    );
    for (const data of rest) {
      if (data && data.results) results.push(...data.results);
    }
  }

  // Dedupe by id, preserving feed order (mini-event expansion repeats ids).
  const byId = new Map();
  for (const ev of results) if (!byId.has(ev.id)) byId.set(ev.id, ev);

  // Narrow to events that could plausibly be ticketed BEFORE hitting the
  // ticket-types endpoint — this is what keeps the cold build fast. The feed
  // mixes in dozens of happy-hours (is_ticketed false, not perennial) that we
  // can drop for free. The only candidates are standalone ticketed events
  // (is_ticketed true) and the perennial top-shelf cards (whose is_ticketed is
  // forced false by the serializer, so the flag can't be trusted for them).
  const candidates = [...byId.values()]
    .filter((ev) => !EXCLUDED_IDS.has(ev.id) && (ev.is_ticketed || ev.is_perennial))
    .slice(0, MAX_TICKET_CHECKS);

  // Confirm each candidate actually has ticket types configured.
  const ticketCounts = await Promise.all(
    candidates.map(async (ev) => {
      const data = await fetchJson(`${API}/ticket/purchase/tickets/${ev.id}/`);
      return data ? data.count || 0 : 0;
    })
  );
  const ticketed = candidates.filter((_, i) => ticketCounts[i] > 0);

  // Order: We Love R&B first, then the other dated (non-perennial) events by
  // date, then the perennial top-shelf tours (which carry no meaningful date).
  const rank = (ev) => {
    if (ev.id === FEATURED_ID) return 0;
    return ev.is_perennial ? 2 : 1;
  };
  ticketed.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return new Date(a.start_date) - new Date(b.start_date);
    return 0;
  });

  return ticketed.map((ev) => ({
    id: ev.id,
    title: ev.title,
    // Perennial top-shelf events recur (e.g. daily tours); a single start
    // date would be misleading, so the card shows no date for them.
    date: ev.is_perennial ? null : ev.start_date,
    endDate: ev.end_date || ev.start_date || null,
    isPerennial: !!ev.is_perennial,
    venue: cardVenue(ev),
    dateLabel: cardDateLabel(ev),
    // Homepage cards render at roughly 400px wide. Prefer the 800px variant
    // for retina displays instead of downloading the 1600px event hero.
    img: LOCAL_MAIN_IMAGES[String(ev.id)] || ev.half_web_image_url || ev.card_image_url || ev.full_web_image_url,
  }));
}

function isCurrentOrFutureEvent(event, now = Date.now()) {
  if (!event || typeof event !== "object") return false;
  const today = dateKeyInTimeZone(now, HOMEPAGE_TIME_ZONE);
  const boundary = validDateValue(event.endDate) || validDateValue(event.date);
  // A perennial event with no finite end date is considered ongoing. Dated
  // events must have a current/future end (or start when no end is supplied).
  if (!boundary) return event.isPerennial === true;
  return dateKeyInTimeZone(boundary, HOMEPAGE_TIME_ZONE) >= today;
}

function validDateValue(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

function dateKeyInTimeZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function applyImageOverrides(events, env) {
  if (!env || !env.OVERRIDES || !events.length) return events;
  const overrides = await Promise.all(
    events.map(async (ev) => {
      try {
        return (
          (await env.OVERRIDES.get(`event:${ev.id}`, "json")) ||
          (await env.OVERRIDES.get(`override:${ev.id}`, "json"))
        );
      } catch {
        return null;
      }
    })
  );
  return events.map((ev, i) => {
    const override = overrides[i];
    const image = homepageOverrideImage(override);
    return image ? { ...ev, img: image } : ev;
  });
}

function homepageOverrideImage(override) {
  if (!override || typeof override !== "object") return "";
  if (typeof override.image === "string" && override.image) return override.image;
  const fields = override.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return "";

  const entries = Object.entries(fields);
  const hero = entries.find(([key, field]) => {
    if (!field || field.type !== "image" || typeof field.value !== "string" || !field.value) return false;
    return (
      key.includes("#evHeroImg") ||
      key.includes(".ev-hero-img") ||
      /^image:main > section:nth-of-type\(1\) > img$/.test(key)
    );
  });
  if (hero) return hero[1].value;

  const firstImage = entries.find(([, field]) => field && field.type === "image" && typeof field.value === "string" && field.value);
  return firstImage ? firstImage[1].value : "";
}

function cardVenue(ev) {
  const local = LOCAL_CARD_INFO[String(ev.id)];
  if (local && local.venue) return local.venue;
  const fromDescription = venueFromText(ev.description || ev.group_description || "");
  if (fromDescription) return fromDescription;
  if (ev.group_name && ev.group_name !== ev.title) return ev.group_name;
  return "Curaçao";
}

function cardDateLabel(ev) {
  const local = LOCAL_CARD_INFO[String(ev.id)];
  if (local && local.dateLabel) return local.dateLabel;
  return ev.is_perennial ? "Flexible dates" : "";
}

function projectVenue(project) {
  const info = project.claudeDesign && Array.isArray(project.claudeDesign.practicalInfo)
    ? project.claudeDesign.practicalInfo
    : [];
  const location = info.find((item) => item && /^location$/i.test(item.key || ""));
  if (location && location.value) return location.value;
  const eyebrow = project.claudeDesign && typeof project.claudeDesign.eyebrow === "string" ? project.claudeDesign.eyebrow : "";
  const parts = eyebrow.split("·").map((part) => part.trim()).filter(Boolean);
  return parts[1] || "Curaçao";
}

function projectDateLabel(project) {
  const meta = project.claudeDesign && Array.isArray(project.claudeDesign.meta) ? project.claudeDesign.meta : [];
  return meta.length ? meta.join(" · ") : "Flexible dates";
}

function venueFromText(value) {
  const match = String(value || "").match(/(?:^|\n)\s*(?:Venue|Location):\s*([^\n\r]+)/i);
  return match ? match[1].trim() : "";
}
