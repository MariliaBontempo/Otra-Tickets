// Cloudflare Pages Function: GET /api/homepage-events
//
// Server-side proxy/aggregator for the homepage events track. The browser
// can't call otraguide.com directly (its CORS allowlist doesn't include
// otratickets.com), so this function fetches the non-perennial events feed
// for category 339, keeps only events that actually have ticket types
// configured, and returns a slim JSON list. Cached at the edge for 5 minutes.

const API = "https://otraguide.com/api";
const CATEGORY_ID = 339;
const MAX_PAGES = 10;
const CACHE_SECONDS = 300;

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/homepage-events", context.request.url));
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Walk the paginated feed. The endpoint prepends a few "top shelf" events
  // from other categories, so filter strictly on category + is_ticketed.
  const byId = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${API}/events/nonperennial/?category_id=${CATEGORY_ID}&page=${page}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) break;
    const data = await resp.json();
    for (const ev of data.results || []) {
      if (ev.category === CATEGORY_ID && ev.is_ticketed && !byId.has(ev.id)) {
        byId.set(ev.id, ev);
      }
    }
    if (!data.next) break;
  }

  // Keep only events whose ticket types are actually configured.
  const candidates = [...byId.values()];
  const ticketCounts = await Promise.all(
    candidates.map(async (ev) => {
      try {
        const resp = await fetch(`${API}/ticket/purchase/tickets/${ev.id}/`, {
          headers: { Accept: "application/json" },
        });
        if (!resp.ok) return 0;
        return (await resp.json()).count || 0;
      } catch {
        return 0;
      }
    })
  );

  const events = candidates
    .filter((_, i) => ticketCounts[i] > 0)
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
    .map((ev) => ({
      id: ev.id,
      title: ev.title,
      date: ev.start_date,
      img: ev.half_web_image_url || ev.full_web_image_url || ev.card_image_url,
    }));

  const response = new Response(JSON.stringify({ events }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
