// Cloudflare Pages Function: GET /api/event?id=<eventId>
//
// Server-side proxy for a single event's detail + ticket types, used by the
// generic event template (event.html). Same CORS reasoning as the homepage
// feed: the browser can't call otraguide.com directly, so we fetch here and
// cache at the edge. Upstream calls are edge-cached too for cheap repeats.

const API = "https://otraguide.com/api";
const UPSTREAM_TTL = 300;
const EDGE_TTL = 600;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(id)) {
    return json({ error: "invalid id" }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/event?id=${id}`, url));
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [detail, ticketData] = await Promise.all([
    fetchJson(`${API}/events/details/${id}/`),
    fetchJson(`${API}/ticket/purchase/tickets/${id}/`),
  ]);

  if (!detail) {
    return json({ error: "not found" }, 404);
  }

  const tickets = (ticketData && ticketData.results ? ticketData.results : []).map((t) => ({
    name: t.name,
    description: t.description || "",
    price: t.price,
    currency: (t.base_currency && t.base_currency.code) || "USD",
  }));

  const payload = {
    id: detail.id,
    title: detail.title,
    description: detail.description || "",
    startDate: detail.start_date || null,
    endDate: detail.end_date || null,
    isTicketed: !!detail.is_ticketed,
    isPerennial: !!detail.is_perennial,
    image:
      detail.full_web_image_url || detail.half_web_image_url || detail.card_image_url || "",
    socialLinks: Array.isArray(detail.social_links) ? detail.social_links : [],
    tickets,
  };

  const response = json(payload, 200, EDGE_TTL);
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
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
