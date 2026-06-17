// Cloudflare Pages Function: GET /api/event?id=<eventId>
//
// Server-side proxy for a single event's detail + ticket types, used by the
// generic event template (event.html). The expensive Otra Guide data is cached;
// the site-side content override is read fresh and merged last.

const API = "https://otraguide.com/api";
const UPSTREAM_TTL = 300;
const EDGE_TTL = 600;

const ACCENT_OVERRIDES = {
  "6113": "#1fa9a0", // Clearboat — turquoise from the original handoff design
};

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(id)) return json({ error: "invalid id" }, 400);

  const base = await getBasePayload(context, id, url);
  if (!base) return json({ error: "not found" }, 404);

  const override = await readOverride(context.env, id);
  const payload = override ? { ...base, ...pickOverride(override) } : base;
  return json(payload, 200, override ? 0 : 60);
}

async function getBasePayload(context, id, url) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/event-base?id=${id}`, url));
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const accentOverride = ACCENT_OVERRIDES[id] || null;
  const [detail, ticketData, calendarAccent] = await Promise.all([
    fetchJson(`${API}/events/details/${id}/`),
    fetchJson(`${API}/ticket/purchase/tickets/${id}/`),
    accentOverride ? Promise.resolve(null) : fetchCalendarPrimary(id),
  ]);
  if (!detail) return null;

  const tickets = (ticketData && ticketData.results ? ticketData.results : []).map((t) => ({
    name: t.name,
    description: t.description || "",
    price: t.price,
    currency: (t.base_currency && t.base_currency.code) || "USD",
  }));

  const base = {
    id: detail.id,
    title: detail.title,
    description: detail.description || "",
    startDate: detail.start_date || null,
    endDate: detail.end_date || null,
    isTicketed: !!detail.is_ticketed,
    isPerennial: !!detail.is_perennial,
    image: detail.full_web_image_url || detail.half_web_image_url || detail.card_image_url || "",
    socialLinks: Array.isArray(detail.social_links) ? detail.social_links : [],
    accent: accentOverride || calendarAccent,
    tickets,
  };

  context.waitUntil(cache.put(cacheKey, json(base, 200, EDGE_TTL).clone()));
  return base;
}

async function readOverride(env, id) {
  const kv = env && env.OVERRIDES;
  if (!kv) return null;
  try {
    const raw = (await kv.get(`event:${id}`)) || (await kv.get(`override:${id}`));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function pickOverride(override) {
  const out = {};
  if (override.description) out.description = override.description;
  if (override.image) out.image = override.image;
  return out;
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

async function fetchCalendarPrimary(id) {
  try {
    const resp = await fetch(`${API.replace(/\/api$/, "")}/ticketing/stripe-external-iframe/calendar/${id}/`, {
      cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const m = html.match(/--theme-primary:\s*(#[0-9A-Fa-f]{6})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
