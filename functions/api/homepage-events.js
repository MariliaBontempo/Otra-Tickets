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
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/homepage-events", context.request.url));
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

// Returns the client-facing response (short browser cache) for a stored body.
function withClientHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=120, stale-while-revalidate=${EDGE_TTL}`);
  return new Response(response.body, { headers });
}

// Build the events list, store it in the edge cache, and return the response.
async function rebuild(cache, cacheKey, now, env) {
  const events = await applyImageOverrides(await buildEvents(), env);
  const body = JSON.stringify({ events });
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
    img: ev.half_web_image_url || ev.full_web_image_url || ev.card_image_url,
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
    return override && typeof override.image === "string" && override.image
      ? { ...ev, img: override.image }
      : ev;
  });
}
