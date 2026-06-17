// Cloudflare Pages Function: GET /admin/api/pages
//
// Staff-only list for the admin dropdown. It returns the hand-built pages first,
// then ticketed Otra Guide events that open through event.html?id=<id>.

const API = "https://otraguide.com/api";
const CATEGORY_ID = 339;
const FEATURED_IDS = new Set([7275, 6113]);
const EXCLUDED_IDS = new Set([7012]);
const PAGE_SIZE = 20;
const MAX_PAGES = 4;
const MAX_TICKET_CHECKS = 40;
const UPSTREAM_TTL = 300;

const MANUAL_PAGES = [
  { id: "7275", title: "We Love R&B", type: "Manual page", url: "/rnb.html" },
  { id: "6113", title: "Clearboat", type: "Manual page", url: "/clearboat.html" },
];

export async function onRequestGet(context) {
  const auth = await requireStaff(context.request);
  if (!auth.ok) return auth.response;

  const dynamic = await buildTemplatePages();
  return json({ pages: [...MANUAL_PAGES, ...dynamic] });
}

async function buildTemplatePages() {
  const pages = await Promise.all(
    Array.from({ length: MAX_PAGES }, (_, i) =>
      fetchJson(`${API}/events/nonperennial/?category_id=${CATEGORY_ID}&page=${i + 1}&page_size=${PAGE_SIZE}`)
    )
  );
  const byId = new Map();
  for (const page of pages) {
    for (const ev of page && page.results ? page.results : []) {
      if (!byId.has(ev.id)) byId.set(ev.id, ev);
    }
  }

  const candidates = [...byId.values()]
    .filter((ev) => !FEATURED_IDS.has(ev.id) && !EXCLUDED_IDS.has(ev.id) && (ev.is_ticketed || ev.is_perennial))
    .slice(0, MAX_TICKET_CHECKS);

  const ticketCounts = await Promise.all(
    candidates.map(async (ev) => {
      const data = await fetchJson(`${API}/ticket/purchase/tickets/${ev.id}/`);
      return data ? data.count || 0 : 0;
    })
  );

  return candidates
    .filter((_, i) => ticketCounts[i] > 0)
    .sort((a, b) => {
      if (a.is_perennial !== b.is_perennial) return a.is_perennial ? 1 : -1;
      return new Date(a.start_date || 0) - new Date(b.start_date || 0);
    })
    .map((ev) => ({
      id: String(ev.id),
      title: ev.title,
      type: ev.is_perennial ? "Template tour" : "Template event",
      url: `/event.html?id=${encodeURIComponent(ev.id)}`,
    }));
}

async function fetchJson(url) {
  try {
    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function requireStaff(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, response: json({ error: "missing token" }, 401) };
  const ok = await checkStaff(m[1]);
  return ok ? { ok: true } : { ok: false, response: json({ error: "forbidden" }, 403) };
}

async function checkStaff(accessToken) {
  try {
    const resp = await fetch(`${API}/users/user-role/`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.is_staff_or_admin;
  } catch {
    return false;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
