// Cloudflare Pages Function: GET /admin/api/pages
//
// Staff-only list for the admin dropdown. It returns the hand-built pages first,
// then ticketed Otra Guide events that open through event.html?id=<id>.
//
// Ticketed events come from the staff Otra Guide calendar feed (category 339,
// about a month back to a year ahead, read in half month chunks) plus the same first 4
// pages of the category feed the list used before, which carry promoted,
// pinned, perennial and still running events the calendar window can miss, so
// the list is always a superset of the old one. The staff Bearer token is
// forwarded so staff-only events such as Cascada NYE appear. Happy hours and
// other unticketed rows are dropped before any lookup. Every remaining event
// is checked through the staff ticketed search, which counts ticket types even
// before their sale opens or after they sell out, and the same search finds
// events known only from KV drafts or overrides (for example unpublished ones).

import { json, otraGet, requireStaff } from "./_auth.js";
import { HIDDEN_PAGES_KEY, readHiddenPageIds } from "../../_lib/hidden-pages.js";

const CATEGORY_ID = 339;
const FEATURED_IDS = new Set([7275, 6113]);
const EXCLUDED_IDS = new Set([7012]);
const LOOKBACK_DAYS = 30;
const LOOKAHEAD_MONTHS = 12;
const MAX_TICKET_CHECKS = 300;
const LOOKUP_CONCURRENCY = 10;
const FEED_HEAD_PAGES = 4;
const FEED_HEAD_SIZE = 20;
const MAX_FALLBACK_LOOKUPS = 25;
const TITLE_SEARCH_LIMIT = 20; // Django AdminTicketedEventSearchAPIView returns at most 20 rows
const LOOKUP_TIMEOUT_MS = 10000;
// The calendar returns every event of the region (about 17k rows and 5 MB a
// year, of which under 1k are ticketed), and for a signed in user Django runs
// two favorite queries per row, so one staff call for the whole year takes
// longer than any sane timeout. It is read in half month chunks instead
// (stable boundaries, so a chunk's cache entry survives across days), a few
// at a time, each with its own timeout. A staff chunk that fails is retried
// anonymously so only its staff only events can be missing, and that is
// reported.
const CHUNK_CONCURRENCY = 9;
const STAFF_CHUNK_TIMEOUT_MS = 20000;
const PUBLIC_CHUNK_TIMEOUT_MS = 10000;
const CHUNK_TTL_SECONDS = 600;
// A request with nothing cached waits at most this long for the calendar.
// Chunks still running keep filling their cache in the background, and the
// partial list says so.
const COLD_BUILD_DEADLINE_MS = 12000;
// A complete list is served for up to LIST_MAX_AGE_SECONDS; after
// LIST_FRESH_SECONDS the next request still gets it at once and a rebuild runs
// in the background.
const LIST_FRESH_SECONDS = 300;
const LIST_MAX_AGE_SECONDS = 6 * 3600;
// Server side only cache entries (never routed). Staff-visible content, so
// they live under admin keys and are only read after requireStaff.
const CACHE_PATH = "/admin/api/pages-upstream-cache";
const CHUNK_CACHE_PATH = "/admin/api/pages-calendar-chunk";
// Calendar rows for a recurring event are per occurrence copies whose title is
// prefixed with the local start time, for example "09:00 - Iguana Ride".
const OCCURRENCE_TITLE = /^\d{2}:\d{2} - /;

const MANUAL_PAGES = [
  { id: "7275", title: "We Love R&B", type: "Manual page", url: "/rnb.html" },
  { id: "6113", title: "Clearboat", type: "Manual page", url: "/clearboat.html" },
];

export async function onRequestGet(context) {
  const auth = await requireStaff(context.request, context.env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const [hiddenIds, drafts, overrideIds] = await Promise.all([
    readHiddenPageIds(context.env),
    buildDraftPages(context.env),
    readOverrideEventIds(context.env),
  ]);
  const knownIds = knownEventIds(drafts, overrideIds);
  const upstream = await getTemplatePages(context, auth, knownIds);
  if (upstream.status === 401) return json({ error: "unauthorized" }, 401);
  const dynamic = upstream.pages;
  // Publishing a draft retires its draft entry immediately: pencil edits on
  // draft ids never reach the public page (it reads the numeric event id).
  // If the upstream feed hasn't caught up with the freshly published event
  // yet, synthesize its live entry from the draft so there's no gap.
  const liveEventIds = new Set(dynamic.map((page) => String(page.id)));
  const visibleDrafts = [];
  const synthesized = [];
  for (const page of drafts) {
    const eventId = page.otraGuideId ? String(page.otraGuideId) : "";
    if (page.status === "published" && eventId) {
      if (!liveEventIds.has(eventId)) {
        liveEventIds.add(eventId);
        synthesized.push({
          id: eventId,
          title: page.title,
          type: "Published draft",
          startDate: page.startDate || "",
          url: `/event.html?id=${encodeURIComponent(eventId)}`,
        });
      }
      continue;
    }
    visibleDrafts.push(page);
  }
  const body = {
    pages: [...visibleDrafts, ...MANUAL_PAGES, ...synthesized, ...dynamic].filter(
      (page) => !hiddenIds.has(String(page.id))
    ),
  };
  if (upstream.error || upstream.note) body.upstreamError = upstream.error || upstream.note;
  return json(body);
}

export async function onRequestPost(context) {
  const auth = await requireStaff(context.request, context.env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const kv = context.env && context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const url = new URL(context.request.url);
  if (url.searchParams.get("action") !== "hide") return json({ error: "unsupported action" }, 400);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const id = String((body && body.id) || "").trim();
  if (!id) return json({ error: "page id is required" }, 400);

  const hiddenIds = await readHiddenPageIds(context.env);
  hiddenIds.add(id);
  await kv.put(HIDDEN_PAGES_KEY, JSON.stringify([...hiddenIds]));
  return json({ hiddenIds: [...hiddenIds] });
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
      if (project.archivedAt) continue;
      const id = key.name.replace(/^site-event:/, "");
      drafts.push({
        id,
        title: typeof project.title === "string" && project.title.trim() ? project.title.trim() : "Claude Design Event",
        type: project.status === "published" ? "Published draft" : "Draft event",
        isDraft: true,
        status: project.status === "published" ? "published" : "draft",
        adminOnly: project.adminOnly === true,
        publishedAt: typeof project.publishedAt === "string" ? project.publishedAt : "",
        otraGuideId: project.otraGuideId ? String(project.otraGuideId) : "",
        syncError: typeof project.syncError === "string" ? project.syncError : "",
        startDate: typeof project.startDate === "string" ? project.startDate : "",
        // Preview the exact Otra Tickets draft selected in the admin. Using
        // otraGuideId here is ambiguous when multiple drafts target the same
        // event and can load an older project's design/assets.
        url: `/event.html?id=${encodeURIComponent(id)}`,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return drafts.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

// Event ids that have saved page overrides. Together with the published
// drafts they are the events the admin already knows about, used to find
// events the calendar feed cannot return (for example unpublished ones).
async function readOverrideEventIds(env) {
  const kv = env && env.OVERRIDES;
  if (!kv) return [];
  const ids = [];
  try {
    for (const prefix of ["event:", "override:"]) {
      let cursor;
      do {
        const page = await kv.list({ prefix, cursor });
        for (const key of page.keys || []) ids.push(key.name.slice(prefix.length));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
  } catch {
    // A KV hiccup only costs the fallback lookups, never the list.
  }
  return ids;
}

// Draft bound events first, then override ids, newest ids first in each.
function knownEventIds(drafts, overrideIds) {
  const byNewest = (a, b) => b - a;
  const fromDrafts = cleanIds(drafts.map((page) => page.otraGuideId || "")).sort(byNewest);
  return [...new Set([...fromDrafts, ...cleanIds(overrideIds).sort(byNewest)])];
}

function cleanIds(values) {
  return values.map((value) => String(value).trim()).filter((value) => /^\d+$/.test(value)).map(Number);
}

// Stale while revalidate wrapper around the built list. A complete list is
// fresh for LIST_FRESH_SECONDS. After that it is still served at once (up to
// LIST_MAX_AGE_SECONDS) while one background rebuild replaces it. Only a
// complete build is stored, so a partial list never replaces a complete one
// and an outage or a rejected token never pins a short list; a request with
// nothing stored builds with a deadline (chunks that finished meanwhile are
// cached, so the next attempt is quicker).
let backgroundRebuild = null;

async function getTemplatePages(context, token, knownIds) {
  const cache = globalThis.caches && globalThis.caches.default;
  const base = context.request ? context.request.url : "";
  const cacheKey = cache && base ? new Request(new URL(CACHE_PATH, base)) : null;
  const io = { cache, base, waitUntil: (p) => (context.waitUntil ? context.waitUntil(p) : undefined) };
  const entry = cacheKey ? await readEntry(cache, cacheKey) : null;

  if (entry) {
    if ((Date.now() - entry.builtAt) / 1000 >= LIST_FRESH_SECONDS && !backgroundRebuild) {
      backgroundRebuild = rebuildAndStore(context.env, token, knownIds, io, cacheKey, Infinity)
        .catch(() => {})
        .finally(() => {
          backgroundRebuild = null;
        });
      io.waitUntil(backgroundRebuild);
    }
    return { status: 200, pages: entry.pages, note: entry.note };
  }
  return rebuildAndStore(context.env, token, knownIds, io, cacheKey, COLD_BUILD_DEADLINE_MS);
}

async function rebuildAndStore(env, token, knownIds, io, cacheKey, deadlineMs) {
  const built = await buildTemplatePages(env, token, knownIds, { ...io, deadlineMs });
  if (cacheKey && built.status === 200 && !built.error) {
    const body = JSON.stringify({ pages: built.pages, note: built.note || "", builtAt: Date.now() });
    const put = io.cache
      .put(cacheKey, new Response(body, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": `max-age=${LIST_MAX_AGE_SECONDS}` },
      }))
      .catch(() => {});
    io.waitUntil(put);
    await put;
  }
  return built;
}

async function readEntry(cache, cacheKey) {
  try {
    const hit = await cache.match(cacheKey);
    if (!hit) return null;
    const payload = await hit.json();
    if (!payload || !Array.isArray(payload.pages)) return null;
    return { pages: payload.pages, note: payload.note || "", builtAt: Number(payload.builtAt) || 0 };
  } catch {
    // Treat an unreadable cache entry as a miss.
    return null;
  }
}

async function buildTemplatePages(env, token, knownIds = [], io = {}) {
  const [calendar, ...feedPages] = await Promise.all([
    readCalendar(env, token, io),
    ...Array.from({ length: FEED_HEAD_PAGES }, (_, i) =>
      otraGet(env, token, `/events/nonperennial/?category_id=${CATEGORY_ID}&page=${i + 1}&page_size=${FEED_HEAD_SIZE}`, {
        timeoutMs: LOOKUP_TIMEOUT_MS,
      })
    ),
  ]);
  if (calendar.status === 401 || feedPages.some((result) => result.status === 401)) return { status: 401, pages: [] };
  const rows = calendar.rows;
  let error = calendar.error;
  // A page past the end of a short feed answers 404; that is not a failure.
  const headRows = [];
  for (const page of feedPages) {
    if (page.data && Array.isArray(page.data.results)) headRows.push(...page.data.results);
    else if (page.status !== 404 && !error) error = `category feed unavailable (${page.status || "network"})`;
  }

  const lookup = ticketedLookup(env, token);
  const resolved = await resolveGroups(env, token, lookup, groupBySlug(rows, Date.now()));
  if (resolved.failed && !error) error = "some recurring events could not be resolved";
  const groups = mergeFeedHead(resolved.groups, headRows);
  const eligible = groups.filter((ev) => !FEATURED_IDS.has(ev.id) && !EXCLUDED_IDS.has(ev.id)).sort(byStart);
  const candidates = eligible.slice(0, MAX_TICKET_CHECKS);
  // A cut is deterministic (rebuilding would cut the same events), so it is
  // reported but does not block caching.
  const note = eligible.length > candidates.length ? `list truncated to ${MAX_TICKET_CHECKS} events` : "";

  const checks = await mapLimited(candidates, LOOKUP_CONCURRENCY, (ev) => lookup.byId(ev.id));
  if (checks.some((check) => check.failed) && !error) error = "some ticket checks failed";
  // Feed candidates already passed a still running rule (calendar groups with a
  // row ending at or after now, the old window's own filter), so Django's
  // isPast, which reads only the parent dates, is not applied to them: an open
  // ended recurring series started in the past would wrongly read as past.
  const listed = candidates.filter((_, i) => hasTickets(checks[i].event));

  const seen = new Set(groups.map((ev) => ev.id));
  const fallbackIds = knownIds
    .filter((id) => !seen.has(id) && !FEATURED_IDS.has(id) && !EXCLUDED_IDS.has(id))
    .slice(0, MAX_FALLBACK_LOOKUPS);
  const fallbackChecks = await mapLimited(fallbackIds, LOOKUP_CONCURRENCY, (id) => lookup.byId(id));
  if (fallbackChecks.some((check) => check.failed) && !error) error = "some saved events could not be checked";
  const fallback = fallbackChecks
    .map((check) => check.event)
    .filter(isEditableSaved)
    .map((ev) => ({
      id: Number(ev.id),
      title: ev.title || `Event ${ev.id}`,
      isPerennial: !!ev.isPerennial,
      startDate: typeof ev.startDate === "string" ? ev.startDate : "",
    }));

  const pages = [...listed, ...fallback]
    .sort((a, b) => {
      if (a.isPerennial !== b.isPerennial) return a.isPerennial ? 1 : -1;
      return byStart(a, b);
    })
    .map((ev) => ({
      id: String(ev.id),
      title: ev.title,
      type: ev.isPerennial ? "Published tour" : "Published draft",
      startDate: ev.startDate,
      url: `/event.html?id=${encodeURIComponent(ev.id)}`,
    }));
  return { status: 200, pages, error, note };
}

// An event belongs in the editor when it has ticket types (on sale, not yet
// on sale or sold out).
function hasTickets(ev) {
  return !!ev && Array.isArray(ev.tickets) && ev.tickets.length > 0;
}

// Saved ids no feed returned also need to not have ended. Perennials never
// count as past, matching isPastPayload in functions/api/event.js.
function isEditableSaved(ev) {
  return hasTickets(ev) && (!ev.isPast || !!ev.isPerennial);
}

// Staff ticketed search, memoized per build. It reads the event records rather
// than the purchase window and records no page views. byId resolves to
// { event } (event null when the id has no ticket types) or { failed: true }.
function ticketedLookup(env, token) {
  const memo = new Map();
  const titles = new Map();
  const remember = (ev) => {
    if (ev && ev.id && !memo.has(Number(ev.id))) memo.set(Number(ev.id), Promise.resolve({ event: ev }));
  };
  return {
    remember,
    byId(id) {
      if (!memo.has(id)) {
        memo.set(
          id,
          otraGet(env, token, `/events/admin-ticketed-search/?id=${id}`, { timeoutMs: LOOKUP_TIMEOUT_MS }).then((result) => {
            if (!result.data || !Array.isArray(result.data.events)) return { failed: true };
            return { event: result.data.events.find((ev) => Number(ev && ev.id) === id) || null };
          })
        );
      }
      return memo.get(id);
    },
    byTitle(title) {
      if (!titles.has(title)) titles.set(title, searchTitle(title));
      return titles.get(title);
    },
  };
  async function searchTitle(title) {
    const result = await otraGet(env, token, `/events/admin-ticketed-search/?q=${encodeURIComponent(title)}`, {
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
    if (!result.data || !Array.isArray(result.data.events)) return { failed: true, events: [] };
    result.data.events.forEach(remember);
    return { events: result.data.events };
  }
}

// Half month chunks, the 1st to the 15th and the 16th to the month's end
// (inclusive dates, as Django reads them), from the chunk holding today minus
// LOOKBACK_DAYS through the one holding today plus LOOKAHEAD_MONTHS.
export function calendarChunks(now) {
  const from = new Date(now.getTime() - LOOKBACK_DAYS * 86400000);
  const until = new Date(now.getTime());
  until.setUTCMonth(until.getUTCMonth() + LOOKAHEAD_MONTHS);
  const chunks = [];
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  let firstHalf = from.getUTCDate() <= 15;
  while (Date.UTC(year, month, firstHalf ? 1 : 16) <= until.getTime()) {
    const lastDay = firstHalf ? 15 : new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    chunks.push({ start: isoDate(year, month, firstHalf ? 1 : 16), end: isoDate(year, month, lastDay) });
    if (!firstHalf) {
      month += 1;
      if (month === 12) {
        month = 0;
        year += 1;
      }
    }
    firstHalf = !firstHalf;
  }
  return chunks;
}

function isoDate(year, month, day) {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

// Reads every chunk, CHUNK_CONCURRENCY at a time. With a finite deadline
// (a request with nothing cached) it stops waiting once the deadline passes;
// the chunks still running carry on in the background and fill their cache.
async function readCalendar(env, token, io = {}) {
  const chunks = calendarChunks(new Date());
  const settled = new Array(chunks.length);
  const all = mapLimited(chunks, CHUNK_CONCURRENCY, async (chunk, i) => {
    settled[i] = await readChunk(env, token, chunk, io);
  });
  // PAGES_COLD_DEADLINE_MS is a test hook; it never caps a background rebuild.
  const coldDeadline = Number.isFinite(io.deadlineMs) ? io.deadlineMs : Infinity;
  const deadlineMs = Number.isFinite(coldDeadline) ? Number(env && env.PAGES_COLD_DEADLINE_MS) || coldDeadline : Infinity;
  if (Number.isFinite(deadlineMs)) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    });
    await Promise.race([all, deadline]);
    clearTimeout(timer);
    if (io.waitUntil) io.waitUntil(all.catch(() => {}));
  } else {
    await all;
  }

  if (settled.some((result) => result && result.status === 401)) return { status: 401, rows: [], error: "" };
  const rows = [];
  let missing = 0;
  let publicOnly = 0;
  for (const result of settled) {
    if (!result || !result.rows) {
      missing += 1;
      continue;
    }
    if (result.publicOnly) publicOnly += 1;
    rows.push(...result.rows);
  }
  let error = "";
  if (missing) {
    error = `calendar incomplete: ${missing} of ${chunks.length} date ranges are still loading or unavailable, reopen the list in a minute`;
  } else if (publicOnly) {
    error = `staff only events may be missing for ${publicOnly} of ${chunks.length} date ranges`;
  }
  return { status: 200, rows, error };
}

// One chunk: its cache entry, else the staff call, else the same call made
// anonymously (public rows only, not cached). Only ticketed or perennial rows
// are kept, which is all the list uses.
async function readChunk(env, token, chunk, io) {
  const path = `/events/nonperennial/calendar/?category_id=${CATEGORY_ID}&start=${chunk.start}&end=${chunk.end}`;
  const key =
    io.cache && io.base ? new Request(new URL(`${CHUNK_CACHE_PATH}/${chunk.start}_${chunk.end}`, io.base)) : null;
  if (key) {
    try {
      const hit = await io.cache.match(key);
      if (hit) {
        const rows = await hit.json();
        if (Array.isArray(rows)) return { rows };
      }
    } catch {
      // Unreadable entry: read the chunk again.
    }
  }

  const staffTimeout = Number(env && env.PAGES_CHUNK_TIMEOUT_MS) || STAFF_CHUNK_TIMEOUT_MS;
  const staff = await otraGet(env, token, path, { timeoutMs: staffTimeout });
  if (staff.status === 401) return { status: 401 };
  if (Array.isArray(staff.data)) {
    const rows = slimRows(staff.data);
    if (key) {
      const put = io.cache
        .put(key, new Response(JSON.stringify(rows), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": `max-age=${CHUNK_TTL_SECONDS}` },
        }))
        .catch(() => {});
      if (io.waitUntil) io.waitUntil(put);
      await put;
    }
    return { rows };
  }

  const publicTimeout = Number(env && env.PAGES_CHUNK_TIMEOUT_MS) || PUBLIC_CHUNK_TIMEOUT_MS;
  const anonymous = await otraGet(env, "", path, { timeoutMs: publicTimeout });
  if (Array.isArray(anonymous.data)) return { rows: slimRows(anonymous.data), publicOnly: true };
  return { rows: null, status: staff.status };
}

function slimRows(rows) {
  return rows
    .filter((row) => row && (row.is_ticketed || row.is_perennial))
    .map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      start_date: row.start_date,
      end_date: row.end_date,
      is_ticketed: row.is_ticketed,
      is_perennial: row.is_perennial,
    }));
}

// Keep only ticketed or perennial rows, then fold the per occurrence rows of a
// recurring event into one entry (earliest start wins). Event.slug is unique
// in Otra Guide; rows without one are keyed by id. Groups whose last row ended
// before now are dropped (the window looks back a month).
function groupBySlug(rows, nowMs) {
  const groups = new Map();
  for (const row of rows) {
    if (!row || !row.id || !(row.is_ticketed || row.is_perennial)) continue;
    const key = row.slug ? `slug:${row.slug}` : `id:${row.id}`;
    const startDate = typeof row.start_date === "string" ? row.start_date : "";
    const endMs = Date.parse(row.end_date || row.start_date || "");
    const occurrence = OCCURRENCE_TITLE.test(String(row.title || ""));
    let group = groups.get(key);
    if (!group) {
      group = {
        id: Number(row.id),
        slug: row.slug || "",
        title: String(row.title || "").replace(OCCURRENCE_TITLE, ""),
        isPerennial: false,
        startDate,
        occurrence: false,
        plainId: 0,
        lastEndMs: -Infinity,
      };
      groups.set(key, group);
    }
    group.occurrence = group.occurrence || occurrence;
    group.isPerennial = group.isPerennial || !!row.is_perennial;
    if (!occurrence && !group.plainId) group.plainId = Number(row.id);
    group.lastEndMs = Math.max(group.lastEndMs, Number.isFinite(endMs) ? endMs : Infinity);
    if (startDate && (!group.startDate || new Date(startDate) < new Date(group.startDate))) group.startDate = startDate;
  }
  return [...groups.values()]
    .filter((group) => group.lastEndMs >= nowMs)
    .map((group) => (group.plainId ? { ...group, id: group.plainId, occurrence: false } : group));
}

// Occurrence rows carry combined ids (event id + occurrence id). Find the base
// event through the staff ticketed search by title, matched on the unique slug
// (no page view is recorded). Only when the title search cannot find it, fall
// back to the detail endpoint, which decodes combined ids. A group that cannot
// be resolved is left out rather than listed under an id the editor cannot
// open; a lookup outage marks the build failed so it is not cached.
async function resolveGroups(env, token, lookup, groups) {
  let failed = false;
  const resolved = await mapLimited(groups, LOOKUP_CONCURRENCY, async (group) => {
    if (!group.occurrence) return group;
    const search = await lookup.byTitle(group.title);
    if (search.failed) failed = true;
    let match = group.slug ? search.events.find((ev) => ev && ev.slug === group.slug) : null;
    // Occurrence rows copy the parent title, and the search returns every
    // ticketed event matching it (up to 20). So when it worked, came back short
    // and the slug is not there, the event has no ticket types: skip the
    // detail call, which records a page view for the staff user.
    const searchConclusive = !search.failed && !!group.slug && search.events.length < TITLE_SEARCH_LIMIT;
    if (!match && !searchConclusive) {
      const detail = await otraGet(env, token, `/events/details/${group.id}/`, { timeoutMs: LOOKUP_TIMEOUT_MS });
      if (detail.data && detail.data.id) match = { id: detail.data.id, title: detail.data.title, isPerennial: detail.data.is_perennial };
      else if (detail.status !== 404) failed = true;
    }
    if (!match) return null;
    return {
      ...group,
      id: Number(match.id),
      title: typeof match.title === "string" && match.title.trim() ? match.title.trim() : group.title,
      isPerennial: !!match.isPerennial,
    };
  });
  const byId = new Map();
  for (const ev of resolved) {
    if (!ev) continue;
    const prior = byId.get(ev.id);
    if (!prior || byStart(ev, prior) < 0) byId.set(ev.id, ev);
  }
  return { groups: [...byId.values()], failed };
}

// Feed rows already carry base event ids (no occurrence copies), so they
// only add events the calendar did not return.
function mergeFeedHead(groups, headRows) {
  const byId = new Map(groups.map((ev) => [ev.id, ev]));
  for (const row of headRows) {
    const id = Number(row && row.id);
    if (!id || byId.has(id) || !(row.is_ticketed || row.is_perennial)) continue;
    byId.set(id, {
      id,
      title: String(row.title || ""),
      isPerennial: !!row.is_perennial,
      startDate: typeof row.start_date === "string" ? row.start_date : "",
    });
  }
  return [...byId.values()];
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function byStart(a, b) {
  return new Date(a.startDate || 0) - new Date(b.startDate || 0);
}
