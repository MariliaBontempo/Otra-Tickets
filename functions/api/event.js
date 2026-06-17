// Cloudflare Pages Function: GET /api/event?id=<eventId>
//
// Server-side proxy for a single event's detail + ticket types, used by the
// generic event template (event.html). Same CORS reasoning as the homepage
// feed: the browser can't call otraguide.com directly, so we fetch here and
// cache at the edge. Upstream calls are edge-cached too for cheap repeats.

const API = "https://otraguide.com/api";
const UPSTREAM_TTL = 300;
const EDGE_TTL = 600;

// Per-event accent overrides. By default the accent comes from the event's
// calendar primary colour in the Otra Guide plugin theme. Listing an event id
// here forces a colour that WINS over that theme colour — use it when the site
// should look different from what's configured in otraguide. Format:
//   "6113": "#fe8a15",   // Clearboat — force orange regardless of the theme
const ACCENT_OVERRIDES = {
  "6113": "#1fa9a0", // Clearboat — turquoise from the original handoff design
};

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(id)) {
    return json({ error: "invalid id" }, 400);
  }

  // The expensive Otra Guide data is cached; the per-event content override is
  // read fresh on every request and merged last, so staff edits show up right
  // away (no waiting for the cache to expire).
  const base = await getBasePayload(context, id, url);
  if (!base) return json({ error: "not found" }, 404);

  const ov = await readOverride(context.env, id);
  const payload = ov ? { ...base, ...pickOverride(ov) } : base;

  return json(payload, 200, 60);
}

// The Otra Guide-derived payload (no content override), edge-cached.
async function getBasePayload(context, id, url) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/event-base?id=${id}`, url));
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  // An accent override wins over the theme colour and skips the calendar fetch.
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
    image:
      detail.full_web_image_url || detail.half_web_image_url || detail.card_image_url || "",
    socialLinks: Array.isArray(detail.social_links) ? detail.social_links : [],
    // Accent colour = the event's calendar primary colour from the Otra Guide
    // plugin theme. null when the event has no custom theme (page uses default).
    accent: accentOverride || calendarAccent,
    tickets,
  };

  context.waitUntil(cache.put(cacheKey, json(base, 200, EDGE_TTL).clone()));
  return base;
}

// Read the staff content override for an event from KV (if the namespace is
// bound). Returns the parsed object or null.
async function readOverride(env, id) {
  const kv = env && env.OVERRIDES;
  if (!kv) return null;
  try {
    const raw = await kv.get(`override:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Only the fields a staff member may override are merged onto the payload.
function pickOverride(ov) {
  const out = {};
  if (ov.description) out.description = ov.description;
  if (ov.image) out.image = ov.image;
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

// The plugin theme's calendar colours aren't exposed as JSON, but they are
// rendered into the calendar iframe as CSS variables. Pull the primary one
// (`--theme-primary`) out of that HTML. Returns a hex string or null.
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
