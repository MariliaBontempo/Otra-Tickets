// Shared homepage feed builder used by the public endpoint
// (GET /api/homepage-events) and the staff-only admin preview
// (GET /admin/api/homepage-events).
//
// The public endpoint keeps its caching strategy (stale-while-revalidate via
// caches.default); the admin variant fetches fresh with the staff Bearer token
// and never touches the shared caches, so admin-only content can never leak
// into a publicly cached response.

import { eventSlug } from "./event-slug.js";

const API = "https://otraguide.com/api";

function apiBase(env) {
  return String((env && env.OTRA_API_URL) || API).replace(/\/$/, "");
}

const CATEGORY_ID = 339;
// We Love R&B is the headliner: it always leads the homepage row.
const FEATURED_ID = 7275;
// Event ids to keep off the homepage even if they pass the ticket filter.
const EXCLUDED_IDS = new Set([
  7012, // Sinusta Tours & Transfers
  7464, // Archived legacy Iguana Ride Curaçao drafts
  7465,
  7466,
]);

export function isHomepageEventExcluded(id) {
  return EXCLUDED_IDS.has(Number(id));
}
const LOCAL_MAIN_IMAGES = {
  "7275": "uploads/We Love R&B July 4th TJ-5.webp",
  "6113": "uploads/Clearboat Hero.webp",
};
const LOCAL_CARD_INFO = {
  "6194": { venue: "Daaibooi Beach", dateLabel: "Fri & Sat · 5PM" },
  "7275": { venue: "Cascada Rooftop", dateLabel: "Saturday July 4 · 6PM" },
  "6113": { venue: "Daaibooi Beach", dateLabel: "Daily · 10AM" },
  "7176": { venue: "Barber Westpunt", dateLabel: "Daily" },
  "6827": { venue: "Pietermaai", dateLabel: "Daily" },
  "7359": { venue: "Curaçao", dateLabel: "Sunday July 5 · 5PM" },
};
const PAGE_SIZE = 20;
const MAX_PAGES = 8;
// Pages fetched together in the first parallel round (covers the usual feed
// size in one hop; more are fetched only if the feed is larger).
const PROBE_PAGES = 4;
// Workers allow 50 subrequests per request; feed pages + ticket checks must
// stay under that, so cap the ticket-type lookups.
const MAX_TICKET_CHECKS = 40;
// How long a cached build is considered fresh. Past this it is still served
// instantly (stale) while a background refresh runs.
const FRESH_SECONDS = 600;
// How long the edge keeps the cached build available for stale-while-
// revalidate. Must be long so caches.default never drops it from under us.
export const EDGE_TTL = 86400;
// Edge-cache the upstream otraguide responses to speed up rebuilds.
const UPSTREAM_TTL = 300;
// KV key for the last-known-good homepage feed snapshot (OVERRIDES namespace).
const SNAPSHOT_KEY = "__homepage_feed_snapshot__";
const HOMEPAGE_TIME_ZONE = "America/Curacao";

// Build the full { events, rows } homepage payload.
//   includeAdminOnly — include KV site events flagged adminOnly (staff preview)
//   authToken        — forward a staff Bearer token upstream so Django also
//                      returns staff_only events; cached under a separate key
export async function buildHomepageFeed(context, { includeAdminOnly = false, authToken = "", forceFresh = false } = {}) {
  const now = Date.now();
  let [siteEvents, upstreamEvents] = await Promise.all([
    buildPublishedSiteEvents(context.env, { includeAdminOnly }),
    authToken
      ? getUpstreamEvents(context, now, forceFresh, authToken, ADMIN_UPSTREAM_CACHE_PATH)
      : getUpstreamEvents(context, now, forceFresh),
  ]);
  // An expired/invalid staff token makes every authed upstream call 401 and
  // the build comes back empty; the public upstream cache is a better answer
  // than an empty Admin View.
  if (authToken && !upstreamEvents.length) {
    upstreamEvents = await getUpstreamEvents(context, now, false);
  }
  // Site events come first so their curated title/image win when the same
  // published Otra Guide event also appears in the upstream public feed.
  const visibleEvents = dedupeEvents([...siteEvents, ...upstreamEvents]);
  const events = await applyImageOverrides(visibleEvents, context.env);
  assignUniqueSlugs(events);
  const rows = await buildRows(events, context.env);
  return { events, rows, hasSiteEvents: siteEvents.length > 0 };
}

// ── Fixed storefront rows ──
// The homepage always opens with fixed categories, mirroring the events
// page handoff: "This Week" (whatever is actually happening during the current
// Mon-Sun week in Curaçao time), "Upcoming Events", "Tours & Adventures", and
// a final "Past Events" row. They are computed from the event list on EVERY
// response - never baked into the edge cache or the KV snapshot - so date-based
// rows keep tracking the calendar even while the feed body is served stale.
const DAY_MS = 86400000;
const THIS_WEEK_ROW = { id: "this-week", title: "This Week" };
const TOURS_ROW = { id: "tours-adventures", title: "Tours & Adventures" };
const UPCOMING_ROW = { id: "upcoming", title: "Upcoming Events" };
const PAST_ROW = { id: "past-events", title: "Past Events" };

export function applyFixedRows(events, rows, now = Date.now()) {
  const currentEvents = events.filter((event) => isCurrentOrFutureEvent(event, now));
  const currentIds = new Set(currentEvents.map((ev) => String(ev.id)));
  const fixed = [
    { ...THIS_WEEK_ROW, eventIds: thisWeekEventIds(currentEvents, now) },
    { ...TOURS_ROW, eventIds: tourEventIds(currentEvents) },
  ];
  // A stored layout row that names a fixed category (e.g. a manually curated
  // "THIS WEEK") is superseded by the computed one.
  const layoutRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && !isFixedHomepageRow(row))
    .map((row) => ({
      ...row,
      eventIds: (Array.isArray(row.eventIds) ? row.eventIds : [])
        .map((id) => String(id))
        .filter((id) => currentIds.has(id)),
    }))
    .filter((row) => row.eventIds.length);
  const merged = [...fixed, ...layoutRows];
  const assigned = new Set(merged.flatMap((row) => row.eventIds));
  // Dated events ascending (soonest first); always-running tours after. The
  // incoming feed order is not chronological (published drafts trail by date),
  // so without this the row could show a later event before an earlier one.
  const missing = currentEvents
    .filter((ev) => !assigned.has(String(ev.id)))
    .sort(byUpcomingDate)
    .map((ev) => String(ev.id));
  // "Upcoming Events" slots in right after This Week, above Tours & Adventures.
  if (missing.length) merged.splice(1, 0, { ...UPCOMING_ROW, eventIds: missing });
  const past = pastEventIds(events, now);
  if (past.length) merged.push({ ...PAST_ROW, eventIds: past });
  return merged.filter((row) => row.eventIds.length);
}

// Two events with the same title would otherwise slugify to the same URL, and
// that URL could only ever open one of them (e.g. clicking the Aug 23 Sunday
// Social card would land on the Sep 6 page). The OLDEST event keeps the clean
// slug and newer same-title events get a dated suffix — so publishing a new
// event (e.g. a clone) only ever changes the new one's URL, never the URL of an
// event that is already live, whatever date the new one lands on.
function assignUniqueSlugs(events) {
  const groups = new Map();
  for (const event of events) {
    const base = eventSlug(event.title);
    event.slug = base;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(event);
  }
  for (const [base, group] of groups) {
    if (group.length < 2) continue;
    // Oldest event first. Otra Guide ids increase with creation time, so the
    // pre-existing event keeps the clean slug and the newly published one (a
    // higher id, or an unpublished draft id) takes the suffix.
    const sorted = [...group].sort((a, b) => {
      const ra = idRank(a);
      const rb = idRank(b);
      if (ra !== rb) return ra - rb;
      return String(a.id).localeCompare(String(b.id));
    });
    const used = new Set();
    sorted.forEach((event, index) => {
      let slug = base;
      if (index > 0) {
        const suffix = slugDateSuffix(event.date);
        slug = suffix ? `${base}-${suffix}` : `${base}-${String(event.id).toLowerCase()}`;
      }
      // Guarantee uniqueness even if two share a date: fall back to the id.
      if (used.has(slug)) slug = `${base}-${String(event.id).toLowerCase()}`;
      used.add(slug);
      event.slug = slug;
    });
  }
}

// Lower rank = created earlier. Numeric Otra Guide ids increase with creation;
// non-numeric draft ids sort last so they never displace an established event.
function idRank(event) {
  const n = Number(event && event.id);
  return Number.isFinite(n) ? n : Infinity;
}

// "Sep 6" -> "sep-6", used to disambiguate same-title event URLs by date.
function slugDateSuffix(date) {
  const iso = validDateValue(date);
  if (!iso) return "";
  const label = new Date(iso).toLocaleDateString("en-US", {
    timeZone: HOMEPAGE_TIME_ZONE,
    month: "short",
    day: "numeric",
  });
  return eventSlug(label);
}

// Rows the server manages automatically. They are recomputed on every feed
// response and must never be stored in homepage:layout - the admin editor
// shows them locked and the layout PUT strips them before saving.
export function isFixedHomepageRow(row) {
  if (!row || typeof row !== "object") return false;
  const id = String(row.id || "");
  const key = rowTitleKey(row.title);
  return [THIS_WEEK_ROW, UPCOMING_ROW, TOURS_ROW, PAST_ROW].some(
    (fixedRow) => id === fixedRow.id || key === rowTitleKey(fixedRow.title)
  );
}

function rowTitleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Chronological order for the Upcoming row: dated events soonest-first, with
// perennial tours (no meaningful single date) sorted after them.
function byUpcomingDate(a, b) {
  const ap = a.isPerennial === true;
  const bp = b.isPerennial === true;
  if (ap !== bp) return ap ? 1 : -1;
  if (ap && bp) return byTourRank(a, b);
  return new Date(a.date || 0) - new Date(b.date || 0);
}

function thisWeekEventIds(events, now) {
  const todayKey = dateKeyInTimeZone(now, HOMEPAGE_TIME_ZONE);
  const weekEndKey = dateKeyInTimeZone(now + daysUntilSunday(now) * DAY_MS, HOMEPAGE_TIME_ZONE);
  const happening = events.filter((ev) => happensDuring(ev, todayKey, weekEndKey));
  // Dated events lead (soonest first); the always-running tours fill in after.
  const dated = happening
    .filter((ev) => ev.isPerennial !== true)
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  const tours = happening.filter((ev) => ev.isPerennial === true).sort(byTourRank);
  return [...dated, ...tours].map((ev) => String(ev.id));
}

// Days left until the Sunday that closes the current week in Curaçao.
function daysUntilSunday(now) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: HOMEPAGE_TIME_ZONE,
    weekday: "short",
  }).format(new Date(now));
  const index = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
  return index < 0 ? 0 : 6 - index;
}

// Does the event's date span touch the [fromKey..toKey] day window?
function happensDuring(ev, fromKey, toKey) {
  const start = validDateValue(ev.date);
  const end = validDateValue(ev.endDate) || start;
  // No usable dates at all: only an ongoing perennial claims the week.
  if (!start && !end) return ev.isPerennial === true;
  const startKey = start ? dateKeyInTimeZone(start, HOMEPAGE_TIME_ZONE) : null;
  const endKey = end ? dateKeyInTimeZone(end, HOMEPAGE_TIME_ZONE) : null;
  return (!startKey || startKey <= toKey) && (!endKey || endKey >= fromKey);
}

function tourEventIds(events) {
  return events
    .filter((ev) => ev.isPerennial === true)
    .sort(byTourRank)
    .map((ev) => String(ev.id));
}

function pastEventIds(events, now) {
  return events
    .filter(
      (ev) =>
        !isCurrentOrFutureEvent(ev, now) &&
        (!isRecurringHomepageEvent(ev) || ev.hasTicketTypes === true)
    )
    .sort((a, b) => pastSortTime(b) - pastSortTime(a))
    .map((ev) => String(ev.id));
}

function isRecurringHomepageEvent(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (ev.isPerennial === true) return true;
  const label = String(ev.dateLabel || "").toLowerCase();
  return /\b(?:daily|nightly|weekly|flexible dates|departures?)\b/.test(label);
}

function pastSortTime(ev) {
  const value = validDateValue(ev.endDate) || validDateValue(ev.date);
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function byTourRank(a, b) {
  return tourRank(a) - tourRank(b);
}

function tourRank(ev) {
  const title = String((ev && ev.title) || "").toLowerCase();
  if (/clear\s*boat/.test(title)) return 0;
  if (title.includes("iguana")) return 1;
  return 2;
}

// Read the KV snapshot and validate it. Returns the snapshot object or null.
async function readSnapshot(env) {
  if (!env || !env.OVERRIDES) return null;
  try {
    const raw = await env.OVERRIDES.get(SNAPSHOT_KEY, "json");
    if (!raw || !Array.isArray(raw.events) || !Array.isArray(raw.rows) || raw.events.length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

// Write the last-known-good snapshot to KV. Skipped when events is empty
// (never overwrite a good snapshot with a failed/empty build).
async function writeSnapshot(env, { events, rows, hasSiteEvents }) {
  if (!env || !env.OVERRIDES || !events.length) return;
  await env.OVERRIDES.put(
    SNAPSHOT_KEY,
    JSON.stringify({ events, rows, hasSiteEvents, generatedAt: Date.now() })
  );
}

// Public homepage feed with a three-tier latency strategy:
//   edge hit  -> serve instantly via existing SWR (feedSource: "edge")
//   KV hit    -> serve snapshot instantly, rebuild in background (feedSource: "kv-stale")
//   cold      -> foreground build, snapshot-write in background (feedSource: "origin")
// forceFresh skips both fast paths and always rebuilds from origin.
// The fixed rows (This Week / Tours & Adventures) are applied on the way out,
// after every cache/snapshot path, so they always reflect the current date.
export async function getPublicHomepageFeed(context, options = {}) {
  const result = await getPublicHomepageFeedRaw(context, options);
  return { ...result, rows: applyFixedRows(result.events, result.rows) };
}

async function getPublicHomepageFeedRaw(context, { forceFresh = false } = {}) {
  if (forceFresh) {
    const result = await buildHomepageFeed(context, { forceFresh: true });
    context.waitUntil(writeSnapshot(context.env, result));
    return { ...result, feedSource: "origin" };
  }

  const probeKey = new Request(new URL("/api/homepage-upstream-events", context.request.url));
  const edgeHit = await caches.default.match(probeKey);

  if (edgeHit) {
    const result = await buildHomepageFeed(context, {});
    return { ...result, feedSource: "edge" };
  }

  const snapshot = await readSnapshot(context.env);

  if (snapshot) {
    context.waitUntil(
      buildHomepageFeed(context, {}).then((fresh) => writeSnapshot(context.env, fresh))
    );
    return {
      events: snapshot.events,
      rows: snapshot.rows,
      hasSiteEvents: snapshot.hasSiteEvents,
      feedSource: "kv-stale",
    };
  }

  const result = await buildHomepageFeed(context, {});
  context.waitUntil(writeSnapshot(context.env, result));
  return { ...result, feedSource: "origin" };
}

// The admin (staff) upstream build is cached under its own key so the public
// cache never mixes with staff-visible content. The cache API is only ever
// read/written server-side, after requireStaff has gated the request.
const ADMIN_UPSTREAM_CACHE_PATH = "/admin/api/homepage-upstream-events";

async function getUpstreamEvents(context, now, forceFresh, authToken = "", cachePath = "/api/homepage-upstream-events") {
  const cache = caches.default;
  const cacheKey = new Request(new URL(cachePath, context.request.url));
  const cached = await cache.match(cacheKey);
  if (cached && !forceFresh) {
    const generatedAt = Number(cached.headers.get("x-generated-at")) || 0;
    const ageSeconds = (now - generatedAt) / 1000;
    if (ageSeconds >= FRESH_SECONDS) {
      context.waitUntil(storeUpstreamEvents(cache, cacheKey, now, authToken, context.env));
    }
    try {
      const payload = await cached.json();
      return Array.isArray(payload.events) ? payload.events : [];
    } catch {
      return [];
    }
  }

  const stored = await storeUpstreamEvents(cache, cacheKey, now, authToken, context.env);
  try {
    const payload = await stored.json();
    return Array.isArray(payload.events) ? payload.events : [];
  } catch {
    return [];
  }
}

async function storeUpstreamEvents(cache, cacheKey, now, authToken = "", env = null) {
  const events = await buildEvents(authToken, env);
  const body = JSON.stringify({ events });
  const stored = new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${EDGE_TTL}`,
      "x-generated-at": String(now),
    },
  });
  // An empty build usually means the upstream rejected the request (expired
  // staff token, outage) — don't poison the cache with it.
  if (events.length) await cache.put(cacheKey, stored.clone());
  return stored;
}

// Raw curated layout rows from KV. Events the layout doesn't place are NOT
// force-fitted here - applyFixedRows sweeps them into "Upcoming Events" at
// serve time, so the stored snapshot stays a faithful copy of the layout.
async function buildRows(events, env) {
  const existing = new Set(events.map((ev) => String(ev.id)));
  const kv = env && env.OVERRIDES;
  if (!kv) return [];

  let layout;
  try {
    layout = await kv.get("homepage:layout", "json");
  } catch {
    layout = null;
  }
  return normalizeRows(layout && layout.rows, existing);
}

function normalizeRows(raw, existing) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row, i) => {
      const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `row-${i + 1}`;
      const title = typeof row.title === "string" ? row.title.trim().slice(0, 80) : "";
      const eventIds = Array.isArray(row.eventIds)
        ? [...new Set(row.eventIds.map((value) => String(value)).filter((id) => existing.has(id)))]
        : [];
      return { id, title, eventIds };
    })
    .filter((row) => row.eventIds.length);
}

export async function buildPublishedSiteEvents(env, { includeAdminOnly = false } = {}) {
  const kv = env && env.OVERRIDES;
  if (!kv) return [];

  const out = [];
  let cursor;
  do {
    let page;
    try {
      page = await kv.list({ prefix: "site-event:", cursor });
    } catch {
      return out;
    }
    for (const key of page.keys || []) {
      let project;
      try {
        project = await kv.get(key.name, "json");
      } catch {
        project = null;
      }
      if (!project || typeof project !== "object" || project.status !== "published") continue;
      // Admin-only site events never reach the public feed (which is edge
      // cached); only the staff preview endpoint opts in to seeing them.
      if (project.adminOnly === true && !includeAdminOnly) continue;
      const draftId = key.name.replace(/^site-event:/, "");
      const id = project.otraGuideId ? String(project.otraGuideId) : draftId;
      const localCard = LOCAL_CARD_INFO[id];
      const startDate = validDateValue(project.startDate);
      const endDate = validDateValue(project.endDate);
      // The card must mirror the event detail's hero photo. A published draft's
      // live hero is edited into its draft override (event:<draftId>), while
      // project.image holds the Otra Guide event's stock image captured at bind
      // time — so prefer the override hero, exactly like the detail page does.
      let overrideImg = "";
      try {
        const draftOverride =
          (await kv.get(`event:${draftId}`, "json")) ||
          (await kv.get(`override:${draftId}`, "json"));
        overrideImg = homepageOverrideImage(draftOverride);
      } catch {
        overrideImg = "";
      }
      out.push({
        id,
        title: projectCardTitle(project),
        date: startDate,
        endDate,
        isPerennial: project.isPerennial === true,
        hasTicketTypes:
          (Array.isArray(project.ticketTypeIds) && project.ticketTypeIds.length > 0) ||
          (Array.isArray(project.claudeDesign && project.claudeDesign.rates) &&
            project.claudeDesign.rates.length > 0),
        venue: (localCard && localCard.venue) || projectVenue(project),
        // KV drafts carry no Otra Guide location; dedupe backfills it from the
        // matching upstream event so the card location still comes from there.
        location: "",
        dateLabel: (localCard && localCard.dateLabel) || projectDateLabel(project),
        img:
          overrideImg ||
          (typeof project.image === "string" && project.image) ||
          (project.claudeDesign && typeof project.claudeDesign.image === "string" && project.claudeDesign.image) ||
          "",
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

async function fetchJson(url, authToken = "") {
  const headers = { Accept: "application/json" };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  try {
    // Authenticated responses must never enter the shared edge cache.
    const resp = await fetch(
      url,
      authToken
        ? { headers }
        : { headers, cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true } }
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function feedUrl(page, api = API) {
  return `${api}/events/nonperennial/?category_id=${CATEGORY_ID}&page=${page}&page_size=${PAGE_SIZE}`;
}

async function buildEvents(authToken = "", env = null) {
  const api = apiBase(env);
  // Fetch the first few pages in one parallel round (the dataset is small, so
  // this usually covers it) instead of waiting on page 1 to learn the count.
  // Only if the feed turns out to be larger do we fetch the remaining pages.
  const probe = Math.min(MAX_PAGES, PROBE_PAGES);
  const firstBatch = await Promise.all(
    Array.from({ length: probe }, (_, i) => fetchJson(feedUrl(i + 1, api), authToken))
  );
  if (!firstBatch[0]) return [];

  const results = [];
  for (const data of firstBatch) {
    if (data && data.results) results.push(...data.results);
  }
  const count = firstBatch[0].count || results.length;
  const totalPages = Math.min(MAX_PAGES, Math.ceil(count / PAGE_SIZE));
  if (totalPages > probe) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - probe }, (_, i) => fetchJson(feedUrl(probe + i + 1, api), authToken))
    );
    for (const data of rest) {
      if (data && data.results) results.push(...data.results);
    }
  }

  // Dedupe by id, preserving feed order (mini-event expansion repeats ids).
  const byId = new Map();
  for (const ev of results) if (!byId.has(ev.id)) byId.set(ev.id, ev);

  // Narrow to events that could plausibly be ticketed BEFORE hitting the
  // ticket-types endpoint — this is what keeps the cold build fast. The feed
  // mixes in dozens of happy-hours (is_ticketed false, not perennial) that we
  // can drop for free. The only candidates are standalone ticketed events
  // (is_ticketed true) and the perennial top-shelf cards (whose is_ticketed is
  // forced false by the serializer, so the flag can't be trusted for them).
  const candidates = [...byId.values()]
    .filter((ev) => !isHomepageEventExcluded(ev.id) && (ev.is_ticketed || ev.is_perennial))
    .slice(0, MAX_TICKET_CHECKS);

  // Confirm each candidate actually has ticket types configured.
  const ticketCounts = await Promise.all(
    candidates.map(async (ev) => {
      const data = await fetchJson(`${api}/ticket/purchase/tickets/${ev.id}/`, authToken);
      return data ? data.count || 0 : 0;
    })
  );
  const ticketed = candidates.filter((_, i) => ticketCounts[i] > 0);

  // Order: We Love R&B first, then the other dated (non-perennial) events by
  // date, then the perennial top-shelf tours (which carry no meaningful date).
  const rank = (ev) => {
    if (ev.id === FEATURED_ID) return 0;
    return ev.is_perennial ? 2 : 1;
  };
  ticketed.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return new Date(a.start_date) - new Date(b.start_date);
    return 0;
  });

  return ticketed.map((ev) => ({
    id: ev.id,
    title: ev.title,
    // Perennial top-shelf events recur (e.g. daily tours); a single start
    // date would be misleading, so the card shows no date for them.
    date: ev.is_perennial ? null : ev.start_date,
    endDate: ev.end_date || ev.start_date || null,
    isPerennial: !!ev.is_perennial,
    // Reaching this map means the purchase endpoint confirmed at least one
    // ticket type. Keep that fact so an expired perennial ticketed event can
    // appear in Past Events instead of being mistaken for an ongoing tour.
    hasTicketTypes: true,
    venue: cardVenue(ev),
    // Real Otra Guide event location (empty when unset) — wins over a curated
    // venue during dedupe so the location always reflects the event.
    location: eventLocation(ev),
    dateLabel: cardDateLabel(ev),
    // Homepage cards render at roughly 400px wide. Prefer the 800px variant
    // for retina displays instead of downloading the 1600px event hero.
    img: LOCAL_MAIN_IMAGES[String(ev.id)] || ev.half_web_image_url || ev.card_image_url || ev.full_web_image_url,
  }));
}

function isCurrentOrFutureEvent(event, now = Date.now()) {
  if (!event || typeof event !== "object") return false;
  const today = dateKeyInTimeZone(now, HOMEPAGE_TIME_ZONE);
  const boundary = validDateValue(event.endDate) || validDateValue(event.date);
  // A perennial event with no finite end date is considered ongoing. Dated
  // events must have a current/future end (or start when no end is supplied).
  if (!boundary) return event.isPerennial === true;
  return dateKeyInTimeZone(boundary, HOMEPAGE_TIME_ZONE) >= today;
}

function dedupeEvents(events) {
  // Site events come first so their curated title/image win. But the location
  // must come from the Otra Guide event: when a real event location exists on
  // either copy (e.g. the upstream feed duplicate of a published draft), it
  // overrides the curated venue.
  const byId = new Map();
  for (const event of events) {
    const id = String((event && event.id) || "");
    if (!id) continue;
    const kept = byId.get(id);
    if (!kept) {
      byId.set(id, event);
      continue;
    }
    const loc = String(kept.location || event.location || "").trim();
    if (loc) kept.venue = loc;
    if (event.hasTicketTypes === true) kept.hasTicketTypes = true;
  }
  return [...byId.values()];
}

function validDateValue(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

function dateKeyInTimeZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function applyImageOverrides(events, env) {
  if (!env || !env.OVERRIDES || !events.length) return events;
  const overrides = await Promise.all(
    events.map(async (ev) => {
      try {
        return (
          (await env.OVERRIDES.get(`event:${ev.id}`, "json")) ||
          (await env.OVERRIDES.get(`override:${ev.id}`, "json"))
        );
      } catch {
        return null;
      }
    })
  );
  return events.map((ev, i) => {
    const override = overrides[i];
    const image = homepageOverrideImage(override);
    return image ? { ...ev, img: image } : ev;
  });
}

function homepageOverrideImage(override) {
  if (!override || typeof override !== "object") return "";
  // Video overrides are stored as image-type fields; a card <img> can't
  // render an mp4, so videos never qualify as the card image.
  const isStillImage = (value) =>
    typeof value === "string" && value && !/\.(mp4|webm|mov)(\?|#|$)/i.test(value);
  if (isStillImage(override.image)) return override.image;
  const fields = override.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return "";

  const entries = Object.entries(fields);
  const hero = entries.find(([key, field]) => {
    if (!field || field.type !== "image" || !isStillImage(field.value)) return false;
    return (
      key.includes("#evHeroImg") ||
      key.includes(".ev-hero-img") ||
      /^image:main > section:nth-of-type\(1\) > img$/.test(key)
    );
  });
  if (hero) return hero[1].value;

  const firstImage = entries.find(([, field]) => field && field.type === "image" && isStillImage(field.value));
  return firstImage ? firstImage[1].value : "";
}

// The card location comes from the Otra Guide event itself (Event.location).
// Ignore a value that merely repeats the title — some events store the title
// in that field instead of a real venue.
function eventLocation(ev) {
  const loc = ev && typeof ev.location === "string" ? ev.location.trim() : "";
  return loc && loc !== String((ev && ev.title) || "").trim() ? loc : "";
}

function cardVenue(ev) {
  const loc = eventLocation(ev);
  if (loc) return loc;
  // Fallbacks for events whose Otra Guide location is empty or unhelpful.
  const local = LOCAL_CARD_INFO[String(ev.id)];
  if (local && local.venue) return local.venue;
  const fromDescription = venueFromText(ev.description || ev.group_description || "");
  if (fromDescription) return fromDescription;
  if (ev.group_name && ev.group_name !== ev.title) return ev.group_name;
  return "Curaçao";
}

function cardDateLabel(ev) {
  const local = LOCAL_CARD_INFO[String(ev.id)];
  if (local && local.dateLabel) return local.dateLabel;
  return ev.is_perennial ? "Flexible dates" : "";
}

function projectVenue(project) {
  const info = project.claudeDesign && Array.isArray(project.claudeDesign.practicalInfo)
    ? project.claudeDesign.practicalInfo
    : [];
  const location = info.find((item) => item && /^location$/i.test(item.key || ""));
  if (location && location.value) return location.value;
  const eyebrow = project.claudeDesign && typeof project.claudeDesign.eyebrow === "string" ? project.claudeDesign.eyebrow : "";
  const parts = eyebrow.split("·").map((part) => part.trim()).filter(Boolean);
  return parts[1] || "Curaçao";
}

function projectCardTitle(project) {
  const title = typeof project.title === "string" ? project.title.trim() : "";
  const design = project.claudeDesign && typeof project.claudeDesign === "object" ? project.claudeDesign : {};
  const displayTitle = typeof design.displayTitle === "string" ? design.displayTitle.trim() : "";
  const subtitle = typeof design.subtitle === "string" ? design.subtitle.trim() : "";

  // Claude designs store the hero subtitle alongside the event title for the
  // event detail page. On homepage cards that subtitle can be a ticket type,
  // so keep the card's first line limited to the actual event title.
  if (displayTitle && (!title || (subtitle && title === `${displayTitle} - ${subtitle}`))) return displayTitle;
  return title || displayTitle || "Claude Design Event";
}

const CARD_DATE_RE = /(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,?\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?/gi;

export function projectDateLabel(project) {
  const design = project.claudeDesign && typeof project.claudeDesign === "object" ? project.claudeDesign : {};
  const meta = Array.isArray(design.meta) ? design.meta : [];
  const rateNames = Array.isArray(design.rates)
    ? design.rates.map((rate) => String(rate && rate.name || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const schedule = meta
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => !isTicketMetadata(item, rateNames));

  const actualDate = validDateValue(project.startDate);
  if (actualDate) {
    const label = new Date(actualDate).toLocaleDateString("en-US", {
      weekday: "short", month: "long", day: "numeric",
      timeZone: HOMEPAGE_TIME_ZONE,
    });
    let replaced = false;
    const synchronized = schedule.map((item) => {
      CARD_DATE_RE.lastIndex = 0;
      if (!CARD_DATE_RE.test(item)) return item;
      replaced = true;
      CARD_DATE_RE.lastIndex = 0;
      return item.replace(CARD_DATE_RE, label);
    });
    if (!replaced) synchronized.unshift(label);
    return synchronized.join(" · ");
  }
  // "Flexible dates" is only accurate for perennial events. A dated event
  // with no start date retains its authored schedule as a last-resort label.
  return schedule.length ? schedule.join(" · ") : (project.isPerennial ? "Flexible dates" : "");
}

function isTicketMetadata(value, rateNames) {
  const text = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (rateNames.some((name) => text === name || text.startsWith(`${name} `))) return true;
  if (/(?:[$€£ƒ]|\b(?:usd|ang|xcg|awg|eur|naf|fl\.?)\b)\s*\d/i.test(value)) return true;
  return /\b(?:early bird|general admission|ticket(?:s| type)?|presale|door price)\b/i.test(value);
}

function venueFromText(value) {
  const match = String(value || "").match(/(?:^|\n)\s*(?:Venue|Location):\s*([^\n\r]+)/i);
  return match ? match[1].trim() : "";
}
