// Cloudflare Pages Function: GET /api/event?id=<eventId>
//
// Server-side proxy for a single event's detail + ticket types, used by the
// generic event template (event.html). The expensive Otra Guide data is cached;
// the site-side content override is read fresh and merged last.

import { eventSlug } from "../_lib/event-slug.js";
import { checkStaff } from "../admin/api/_auth.js";
import { requestToken } from "../_lib/session.js";
import { findBoundProjects, resolvePageOverride } from "../_lib/page-override.js";
import { hasEnded } from "../_lib/event-ended.js";

const API = "https://otraguide.com/api";
const UPSTREAM_TTL = 300;
const EDGE_TTL = 600;

// The site project's own dates, kept off the JSON (Symbol keys are not
// serialized) so draft pages render exactly as before while isPast still
// knows when the project's event is over.
const PROJECT_DATES = Symbol("projectDates");

const ACCENT_OVERRIDES = {
  "6113": "#1fa9a0", // Clearboat — turquoise from the original handoff design
};

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!isEventId(id)) return json({ error: "invalid id" }, 400);

  // One site event scan: the newest bound project drives the design, the
  // newest published one feeds the page edits.
  const bound = /^\d+$/.test(id) ? await findBoundProjects(context.env && context.env.OVERRIDES, id) : null;
  const project = bound ? bound.latest : null;
  const base = await getBasePayload(context, id, url, project, bound ? bound.published : null);
  if (!base) return json({ error: "not found" }, 404);

  // Admin-only events are hidden from the public; a valid staff Bearer token
  // may still fetch them (used by the admin preview). Staff responses are
  // never cacheable.
  const adminOnly = (project && project.adminOnly === true) || base.adminOnly === true;
  if (adminOnly && !(await isStaffRequest(context))) return json({ error: "not found" }, 404);
  delete base.adminOnly;
  // Non-sensitive marker so the page keeps its /event?id= URL (the public slug
  // route cannot resolve staff-only events). Only ever set on no-store responses.
  const staffPreview = adminOnly || base.staffView === true;
  delete base.staffView;

  const override = await readOverride(context.env, id, bound && bound.published ? String(bound.published.id) : "");
  let payload = override ? { ...base, ...pickOverride(override) } : base;
  if (project) {
    payload = {
      ...payload,
      isDraft: project.status !== "published",
      status: project.status === "published" ? "published" : "draft",
      design: project.claudeDesign || null,
    };
  }
  payload.slug = project && project.frozenSlug ? project.frozenSlug : eventSlug(payload.title);
  if (staffPreview) payload.staffPreview = true;
  // Worked out per response (the base payload is edge cached), so a page
  // stops offering checkout as soon as its event is over.
  payload.isPast = isPastPayload(payload);
  return json(payload, 200, staffPreview || override ? 0 : 60);
}

async function getBasePayload(context, id, url, project, publishedProject = null) {
  if (isDraftId(id)) return getDraftPayload(context.env, id);

  const api = apiBase(context.env);
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/event-base?id=${id}`, url));
  const cached = project ? null : await cache.match(cacheKey);
  if (cached) return cached.json();

  const accentOverride = ACCENT_OVERRIDES[id] || null;
  const ticketsUrl = `${api}/ticket/purchase/tickets/${id}/?include_choice_addons=1`;
  let [detail, ticketData, calendarAccent] = await Promise.all([
    fetchJson(`${api}/events/details/${id}/`),
    fetchJson(ticketsUrl),
    accentOverride ? Promise.resolve(null) : fetchCalendarPrimary(id, api),
  ]);
  if (!detail) {
    // A staff-only Guide event has no public detail response, but a published
    // Otra Tickets project may still sell its ticket types through the embed.
    // Keep this fallback bound to that exact project and a live ticket feed.
    // It applies to every caller, staff included, so staff preview what the
    // public sees.
    if (
      id === "8088" && project?.id === "draft-1791253678425-26c548a5" &&
      project.status === "published" && project.adminOnly !== true && ticketData?.results?.length
    ) {
      const draftPayload = await getDraftPayload(context.env, project.id);
      // The draft key locates site content; the public event ID is the Guide ID.
      return draftPayload ? { ...draftPayload, id: Number(id) } : null;
    }
  }

  // A staff-only Guide event is hidden from anonymous callers but served to a
  // staff JWT. That response is per-user: never cached, never shared.
  let staffView = false;
  if (!detail && (await isStaffRequest(context))) {
    const token = requestToken(context.request);
    [detail, ticketData] = await Promise.all([
      fetchJson(`${api}/events/details/${id}/`, token),
      fetchJson(ticketsUrl, token),
    ]);
    staffView = !!detail;
  }
  if (!detail) return pastProjectPayload(context.env, id, publishedProject, ticketData);

  const { tickets, addons } = ticketLists(ticketData);

  const base = {
    id: detail.id,
    checkoutEventId: detail.id,
    title: detail.title,
    description: detail.description || "",
    startDate: detail.start_date || null,
    endDate: detail.end_date || null,
    isTicketed: !!detail.is_ticketed,
    isPerennial: !!detail.is_perennial,
    // A recurring series keeps selling later dates after its first ends.
    isRecurring: !!(detail.is_recurring || detail.has_mini_events),
    image: detail.full_web_image_url || detail.half_web_image_url || detail.card_image_url || "",
    socialLinks: Array.isArray(detail.social_links) ? detail.social_links : [],
    accent: accentOverride || calendarAccent,
    checkoutBaseUrl: api.replace(/\/api$/, ""),
    tickets,
    addons,
  };

  if (staffView) return { ...base, staffView: true };
  if (!project) context.waitUntil(cache.put(cacheKey, json(base, 200, EDGE_TTL).clone()));
  return base;
}

function isPastPayload(payload) {
  if (payload.isPerennial || payload.isRecurring) return false;
  const dates = payload[PROJECT_DATES];
  if (dates && dates.isPerennial) return false;
  const startDate = payload.startDate || (dates && dates.startDate) || null;
  const endDate = payload.endDate || (dates && dates.endDate) || null;
  return hasEnded(startDate, endDate);
}

// Otra Guide stops serving the public detail of some events once they are
// over (they are hidden from anonymous callers), but their Otra Tickets page
// must stay visible, read only. Serve the published site project's own
// content, which is already public under its draft id, only when its dates
// show the event has ended. The page never mounts checkout for a past event
// (isPast), and nothing here is cached at the edge.
async function pastProjectPayload(env, id, project, ticketData) {
  if (!project || project.status !== "published" || project.adminOnly === true || project.isPerennial === true) return null;
  if (String(project.otraGuideId || "") !== String(id)) return null;
  const startDate = typeof project.startDate === "string" && project.startDate ? project.startDate : null;
  const endDate = typeof project.endDate === "string" && project.endDate ? project.endDate : null;
  if (!hasEnded(startDate, endDate)) return null;
  const draftPayload = await getDraftPayload(env, String(project.id || ""));
  if (!draftPayload || draftPayload.adminOnly) return null;
  // The page showed the Guide ticket types while the detail was public; keep
  // them as the record when the feed still has them.
  const { tickets, addons } = ticketLists(ticketData);
  return {
    ...draftPayload,
    id: Number(id),
    checkoutEventId: String(id),
    startDate,
    endDate,
    ...(tickets.length ? { tickets, addons } : {}),
  };
}

function ticketLists(ticketData) {
  const tickets = (ticketData && Array.isArray(ticketData.results) ? ticketData.results : []).map((t) => ({
    name: t.name,
    description: t.description || "",
    price: t.price,
    currency: (t.base_currency && t.base_currency.code) || "USD",
  }));
  const addons = (ticketData && Array.isArray(ticketData.addons) ? ticketData.addons : []).map((a) => ({
    name: a.title,
    description: a.description || "",
    price: a.price,
    currency: a.base_currency || "USD",
  }));
  return { tickets, addons };
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
    adminOnly: draft.adminOnly === true,
    [PROJECT_DATES]: {
      startDate: typeof draft.startDate === "string" ? draft.startDate : "",
      endDate: typeof draft.endDate === "string" ? draft.endDate : "",
      isPerennial: draft.isPerennial === true,
    },
  };
}

// At most one staff check per request, however many gates ask.
const staffChecks = new WeakMap();

function isStaffRequest(context) {
  const request = context.request;
  if (!staffChecks.has(request)) {
    const token = requestToken(request);
    staffChecks.set(request, token ? checkStaff(token, context.env) : Promise.resolve(false));
  }
  return staffChecks.get(request);
}

async function readOverride(env, id, draftId) {
  const kv = env && env.OVERRIDES;
  if (!kv) return null;
  try {
    // A published bound draft keeps its edits under its own id; the shared
    // resolver puts the edits saved under the Otra Guide id on top of them.
    const { override } = await resolvePageOverride(kv, id, { draftId: draftId || "" });
    return override;
  } catch {
    return null;
  }
}

function pickOverride(override) {
  const out = {};
  if (override.description) out.description = override.description;
  if (override.image) out.image = override.image;
  if (override.checkoutEventId) out.checkoutEventId = override.checkoutEventId;
  // The accent saved in the admin wins over the Otra Guide team/calendar color.
  if (typeof override.accentColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(override.accentColor.trim())) {
    out.accent = override.accentColor.trim().toLowerCase();
    // Tells the page to pin this color inside the checkout embed too.
    out.accentIsOverride = true;
  }
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

// With a token the call is per-user: authorised and never edge-cached.
async function fetchJson(url, token = null) {
  try {
    const resp = await fetch(
      url,
      token
        ? { headers: { Accept: "application/json", authorization: `Bearer ${token}` } }
        : { headers: { Accept: "application/json" }, cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true } },
    );
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
