// Cloudflare Pages Function: GET/PUT /admin/api/homepage
//
// Staff-only homepage row layout editor. The public homepage keeps using the
// event feed, while this stores only row order, row titles, and selected card ids.

import { requireStaff, json } from "./_auth.js";

const KEY = "homepage:layout";

export async function onRequestGet(context) {
  if (!(await requireStaff(context.request, context.env))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const feed = await fetchHomepageFeed(context.request);
  const events = Array.isArray(feed.events) ? feed.events : [];
  const existing = new Set(events.map((ev) => String(ev.id)));
  let layout = null;
  try {
    layout = await kv.get(KEY, "json");
  } catch {
    layout = null;
  }
  const rows = normalizeRows(layout && layout.rows, existing);
  return json({
    events,
    rows: rows.length ? rows : [{ id: "main", title: "", eventIds: events.map((ev) => String(ev.id)) }],
  });
}

export async function onRequestPut(context) {
  if (!(await requireStaff(context.request, context.env))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  const feed = await fetchHomepageFeed(context.request);
  const existing = new Set((feed.events || []).map((ev) => String(ev.id)));
  const rows = normalizeRows(body && body.rows, existing);
  if (!rows.length) return json({ error: "at least one row with one event is required" }, 400);

  const layout = { rows, updatedAt: new Date().toISOString() };
  await kv.put(KEY, JSON.stringify(layout));
  return json({ rows });
}

async function fetchHomepageFeed(request) {
  try {
    const url = new URL("/api/homepage-events?fresh=1", request.url);
    const resp = await fetch(url, { headers: { accept: "application/json" } });
    if (!resp.ok) return { events: [] };
    return await resp.json();
  } catch {
    return { events: [] };
  }
}

function normalizeRows(raw, existing) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 12)
    .map((row, i) => {
      const id =
        typeof row.id === "string" && row.id.trim()
          ? row.id.trim().slice(0, 80)
          : `row-${Date.now()}-${i}`;
      const title = typeof row.title === "string" ? row.title.trim().slice(0, 80) : "";
      const eventIds = Array.isArray(row.eventIds)
        ? [...new Set(row.eventIds.map((value) => String(value)).filter((id) => existing.has(id)))].slice(0, 40)
        : [];
      return { id, title, eventIds };
    })
    .filter((row) => row.eventIds.length);
}
