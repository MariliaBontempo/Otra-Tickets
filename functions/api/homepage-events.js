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

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/homepage-events", context.request.url));
  const hasLocalEvents = await hasPublishedSiteEvents(context.env);
  const bypassCache = url.searchParams.get("fresh") === "1" || hasLocalEvents;
  if (bypassCache) {
    return withClientHeaders(await rebuild(cache, cacheKey, Date.now(), context.env), hasLocalEvents ? 0 : 120);
  }

  const cached = await cache.match(cacheKey);
  const now = Date.now();

  if (cached) {
    const generatedAt = Number(cached.headers.get("x-generated-at")) || 0;
    const ageSeconds = (now - generatedAt) / 1000;
    if (ageSeconds >= FRESH_SECONDS) {
      // Stale: hand back the cached copy now, rebuild in the background.
      context.waitUntil(rebuild(cache, cacheKey, now, context.env));
    }
    return withClientHeaders(cached);
  }

  // Cold cache: build synchronously (the only time a visitor waits).
  const fresh = await rebuild(cache, cacheKey, now, context.env);
  return withClientHeaders(fresh);
}

async function hasPublishedSiteEvents(env) {
  const kv = env && env.OVERRIDES;
  if (!kv) return false;
  try {
    const page = await kv.list({ prefix: "site-event:" });
    for (const key of page.keys || []) {
      const project = await kv.get(key.name, "json");
      if (project && typeof project === "object" && project.status === "published") return true;
    }
  } catch {
    return false;
  }
  return false;
}

// Returns the client-facing response (short browser cache) for a stored body.
function withClientHeaders(response, maxAge = 120) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", maxAge ? `public, max-age=${maxAge}, stale-while-revalidate=${EDGE_TTL}` : "no-store");
  return new Response(response.body, { headers });
}

// Build the events list, store it in the edge cache, and return the response.
async function rebuild(cache, cacheKey, now, env) {
  const [siteEvents, upstreamEvents] = await Promise.all([buildPublishedSiteEvents(env), buildEvents()]);
  const events = await applyImageOverrides([...siteEvents, ...upstreamEvents], env);
  const rows = await buildRows(events, env);
  const body = JSON.stringify({ events, rows });
  // Stored with a long max-age so caches.default keeps it for SWR; freshness
  // is tracked by us via the x-generated-at timestamp.
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
      out.push({
        id,
        title: typeof project.title === "string" && project.title.trim() ? project.title.trim() : "Claude Design Event",
        date: project.publishedAt || project.createdAt || null,
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
    img: LOCAL_MAIN_IMAGES[String(ev.id)] || ev.full_web_image_url || ev.half_web_image_url || ev.card_image_url,
  }));
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
