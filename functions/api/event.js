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
  if (!isEventId(id)) return json({ error: "invalid id" }, 400);

  const project = /^\d+$/.test(id) ? await findProjectByOtraGuideId(context.env, id) : null;
  const base = await getBasePayload(context, id, url, project);
  if (!base) return json({ error: "not found" }, 404);

  const override = await readOverride(context.env, id, project && project.id);
  let payload = override ? { ...base, ...pickOverride(override) } : base;
  if (project) {
    payload = {
      ...payload,
      isDraft: project.status !== "published",
      status: project.status === "published" ? "published" : "draft",
      design: project.claudeDesign || null,
    };
  }
  return json(payload, 200, override ? 0 : 60);
}

async function getBasePayload(context, id, url, project) {
  if (isDraftId(id)) return getDraftPayload(context.env, id);

  const api = apiBase(context.env);
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/event-base?id=${id}`, url));
  const cached = project ? null : await cache.match(cacheKey);
  if (cached) return cached.json();

  const accentOverride = ACCENT_OVERRIDES[id] || null;
  const [detail, ticketData, calendarAccent] = await Promise.all([
    fetchJson(`${api}/events/details/${id}/`),
    fetchJson(`${api}/ticket/purchase/tickets/${id}/`),
    accentOverride ? Promise.resolve(null) : fetchCalendarPrimary(id, api),
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
    checkoutEventId: detail.id,
    title: detail.title,
    description: detail.description || "",
    startDate: detail.start_date || null,
    endDate: detail.end_date || null,
    isTicketed: !!detail.is_ticketed,
    isPerennial: !!detail.is_perennial,
    image: detail.full_web_image_url || detail.half_web_image_url || detail.card_image_url || "",
    socialLinks: Array.isArray(detail.social_links) ? detail.social_links : [],
    accent: accentOverride || calendarAccent,
    checkoutBaseUrl: api.replace(/\/api$/, ""),
    tickets,
  };

  if (!project) context.waitUntil(cache.put(cacheKey, json(base, 200, EDGE_TTL).clone()));
  return base;
}

async function findProjectByOtraGuideId(env, id) {
  const kv = env && env.OVERRIDES;
  if (!kv) return null;
  let latest = null;
  let cursor;
  do {
    const page = await kv.list({ prefix: "site-event:", cursor });
    for (const key of page.keys || []) {
      const project = await kv.get(key.name, "json");
      if (!project || project.archivedAt || String(project.otraGuideId || "") !== String(id)) continue;
      if (!latest || String(project.createdAt || "") > String(latest.createdAt || "")) latest = project;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return latest;
}

function apiBase(env) {
  return String((env && env.OTRA_API_URL) || API).replace(/\/$/, "");
}

async function getDraftPayload(env, id) {
  const kv = env && env.OVERRIDES;
  if (!kv) return null;

  const draft = await kv.get(`site-event:${id}`, "json");
  if (!draft || typeof draft !== "object") return null;

  const rates = Array.isArray(draft.claudeDesign && draft.claudeDesign.rates) ? draft.claudeDesign.rates : [];
  return {
    id,
    checkoutEventId: /^\d+$/.test(String(draft.otraGuideId || "")) ? String(draft.otraGuideId) : "",
    title: typeof draft.title === "string" && draft.title.trim() ? draft.title.trim() : "Claude Design Event",
    description:
      typeof draft.description === "string" && draft.description.trim()
        ? draft.description.trim()
        : "Draft event created from a Claude Design project.",
    startDate: null,
    endDate: null,
    isTicketed: rates.length > 0,
    isPerennial: false,
    image: typeof draft.image === "string" ? draft.image : "",
    socialLinks: [],
    accent: "#1c9ebd",
    checkoutBaseUrl: apiBase(env).replace(/\/api$/, ""),
    tickets: rates,
    isDraft: true,
    status: draft.status === "published" ? "published" : "draft",
    design: draft.claudeDesign && typeof draft.claudeDesign === "object" ? draft.claudeDesign : null,
  };
}

async function readOverride(env, id, fallbackId = "") {
  const kv = env && env.OVERRIDES;
  if (!kv) return null;
  try {
    const raw =
      (await kv.get(`event:${id}`)) ||
      (await kv.get(`override:${id}`)) ||
      (fallbackId ? await kv.get(`event:${fallbackId}`) : null) ||
      (fallbackId ? await kv.get(`override:${fallbackId}`) : null);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function pickOverride(override) {
  const out = {};
  if (override.description) out.description = override.description;
  if (override.image) out.image = override.image;
  if (override.checkoutEventId) out.checkoutEventId = override.checkoutEventId;
  return out;
}

function isEventId(id) {
  return /^\d+$/.test(id) || isDraftId(id);
}

function isDraftId(id) {
  return /^draft-[a-zA-Z0-9-]+$/.test(id);
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

async function fetchCalendarPrimary(id, api = API) {
  try {
    const resp = await fetch(`${api.replace(/\/api$/, "")}/ticketing/stripe-external-iframe/calendar/${id}/`, {
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
