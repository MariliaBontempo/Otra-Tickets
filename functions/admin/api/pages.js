// Cloudflare Pages Function: GET /admin/api/pages
//
// Staff-only list for the admin dropdown. It returns the hand-built pages first,
// then ticketed Otra Guide events that open through event.html?id=<id>.

import { apiBase, requireStaff } from "./_auth.js";

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
  const auth = await requireStaff(context.request, context.env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const [drafts, dynamic] = await Promise.all([buildDraftPages(context.env), buildTemplatePages(apiBase(context.env))]);
  return json({ pages: [...drafts, ...MANUAL_PAGES, ...dynamic] });
}

async function buildDraftPages(env) {
  const kv = env && env.OVERRIDES;
  if (!kv) return [];

  const drafts = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "site-event:", cursor });
    for (const key of page.keys || []) {
      const project = await kv.get(key.name, "json");
      if (!project || typeof project !== "object") continue;
      const id = key.name.replace(/^site-event:/, "");
      drafts.push({
        id,
        title: typeof project.title === "string" && project.title.trim() ? project.title.trim() : "Claude Design Event",
        type: project.status === "published" ? "Published draft" : "Draft event",
        isDraft: true,
        status: project.status === "published" ? "published" : "draft",
        otraGuideId: project.otraGuideId ? String(project.otraGuideId) : "",
        syncError: typeof project.syncError === "string" ? project.syncError : "",
        url: project.otraGuideId
          ? `/event.html?id=${encodeURIComponent(project.otraGuideId)}`
          : `/event.html?id=${encodeURIComponent(id)}`,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return drafts.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

async function buildTemplatePages(apiUrl = API) {
  const pages = await Promise.all(
    Array.from({ length: MAX_PAGES }, (_, i) =>
      fetchJson(`${apiUrl}/events/nonperennial/?category_id=${CATEGORY_ID}&page=${i + 1}&page_size=${PAGE_SIZE}`)
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
      const data = await fetchJson(`${apiUrl}/ticket/purchase/tickets/${ev.id}/`);
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
