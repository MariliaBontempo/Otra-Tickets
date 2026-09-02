// Cloudflare Pages Function: GET/PUT /admin/api/homepage
//
// Staff-only homepage row layout editor. The public homepage keeps using the
// event feed, while this stores only row order, row titles, and selected card ids.
//
// The fixed rows (This Week / Upcoming Events / Tours & Adventures) are
// computed by the feed, not stored: GET returns them marked { fixed: true }
// so the editor can show them locked in place, and PUT strips them so they
// never enter the saved layout.

import { requireStaff, staffSession, json } from "./_auth.js";
import { actorForAudit, appendAudit, HOMEPAGE_AUDIT_ID } from "./_audit.js";
import { applyFixedRows, isFixedHomepageRow } from "../../_lib/homepage-feed.js";

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
  return json({ events, rows: markFixedRows(applyFixedRows(events, rows)) });
}

export async function onRequestPut(context) {
  const session = await staffSession(context.request, context.env);
  if (!session) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  const feed = await fetchHomepageFeed(context.request);
  const events = Array.isArray(feed.events) ? feed.events : [];
  const existing = new Set(events.map((ev) => String(ev.id)));
  // The fixed rows always exist on top, so an empty curated layout is valid.
  const rows = normalizeRows(body && body.rows, existing).filter((row) => !isFixedHomepageRow(row));

  let previousRows = [];
  try {
    const previous = await kv.get(KEY, "json");
    previousRows = previous && Array.isArray(previous.rows) ? previous.rows : [];
  } catch {
    previousRows = [];
  }

  const layout = { rows, updatedAt: new Date().toISOString() };
  await kv.put(KEY, JSON.stringify(layout));
  await appendAudit(kv, {
    actor: await actorForAudit(session.token, session.role, context.env),
    action: "save",
    pageId: HOMEPAGE_AUDIT_ID,
    changedFields: JSON.stringify(previousRows) === JSON.stringify(rows) ? [] : ["rows"],
  });
  return json({ rows: markFixedRows(applyFixedRows(events, rows)) });
}

function markFixedRows(rows) {
  return rows.map((row) => (isFixedHomepageRow(row) ? { ...row, fixed: true } : row));
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
