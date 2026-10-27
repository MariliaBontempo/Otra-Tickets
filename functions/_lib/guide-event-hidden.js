// When Otra Guide answers 404 for an event detail, the event is gone or hidden
// from anonymous visitors, and the storefront shows nothing for it: no page, no
// draft page, no page edits and no homepage or search card. Only an explicit
// 404 counts; an outage or any other error never hides a page.

import { isOtraGuideId } from "./page-override.js";

const API = "https://otraguide.com/api";
const UPSTREAM_TTL = 300;
// A slow Guide never holds a page back: past this, the answer is "not missing".
const CHECK_TIMEOUT_MS = 4000;

// Legacy: Guide id -> the one published project that may keep selling while
// its Guide detail is hidden, as long as its public ticket feed is live. New
// pages use the admin "Keep selling while Guide private" switch instead
// (KEEP_SELLING_FLAG on the project), so this list never grows again.
export const HIDDEN_DETAIL_EXCEPTIONS = Object.freeze({
  "8088": "draft-1791253678425-26c548a5",
  "8266": "draft-1792794458964-79d36de9",
  "8267": "draft-1792794492337-315e4c35",
});

export function guideApiBase(env) {
  return String((env && env.OTRA_API_URL) || API).replace(/\/$/, "");
}

// Every page load asks (the event and its page edits), so a definite answer
// (found or 404) is remembered briefly per process. Errors are never kept.
const STATUS_TTL_MS = 60 * 1000;
const statusMemo = new Map();
// Checks already on their way, so simultaneous requests share one call.
const inFlight = new Map();

export function forgetGuideStatuses() {
  statusMemo.clear();
  inFlight.clear();
}

export async function guideDetailMissing(api, guideId) {
  if (!isOtraGuideId(guideId)) return false;
  const key = `${api}|${guideId}`;
  const memo = statusMemo.get(key);
  if (memo && memo.expires > Date.now()) return memo.missing;
  if (!inFlight.has(key)) {
    inFlight.set(key, checkDetail(api, guideId, key).finally(() => inFlight.delete(key)));
  }
  return inFlight.get(key);
}

async function checkDetail(api, guideId, key) {
  try {
    const resp = await fetch(`${api}/events/details/${guideId}/`, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    // Only the status matters; release the body right away.
    await discardBody(resp);
    if (resp.status === 404 || resp.ok) {
      // Bounded: the oldest answer goes first.
      if (statusMemo.size >= 500) statusMemo.delete(statusMemo.keys().next().value);
      statusMemo.set(key, { missing: resp.status === 404, expires: Date.now() + STATUS_TTL_MS });
    }
    return resp.status === 404;
  } catch {
    return false;
  }
}

async function discardBody(resp) {
  try {
    if (resp.body && typeof resp.body.cancel === "function") await resp.body.cancel();
  } catch {
    // Nothing to release.
  }
}

// The project switch an admin turns on so a page keeps opening and selling
// while its Otra Guide event is private (staff only, detail 404). Unlisted
// alone never does this.
export const KEEP_SELLING_FLAG = "keepSellingWhileGuidePrivate";

// The one rule for the switch: the exact live project bound to this Guide id,
// published, not admin only, not archived, with the switch on.
export function keepsSellingFlagOn(project, guideId, projectId) {
  return (
    !!project && typeof project === "object" &&
    project[KEEP_SELLING_FLAG] === true &&
    !!projectId && String(project.id || projectId) === String(projectId) &&
    isOtraGuideId(guideId) && String(project.otraGuideId || "") === String(guideId) &&
    project.status === "published" &&
    project.adminOnly !== true &&
    !project.archivedAt
  );
}

async function readProject(kv, projectId) {
  if (!kv || typeof kv.get !== "function" || !/^draft-[a-zA-Z0-9-]+$/.test(String(projectId))) return null;
  try {
    const raw = await kv.get(`site-event:${projectId}`, "json");
    return raw && typeof raw === "object" ? { ...raw, id: String(projectId) } : null;
  } catch {
    return null;
  }
}

// True when this project may keep selling while its Guide detail is hidden:
// the legacy list above names it, or its own switch is on (source.project, or
// read from source.kv), and its public ticket feed is live. Anything missing
// or failing answers false, so the page stays hidden.
export async function keepsSellingWhileHidden(api, guideId, projectId, ticketData, source = {}) {
  if (!projectId) return false;
  let allowed = HIDDEN_DETAIL_EXCEPTIONS[String(guideId)] === String(projectId);
  if (!allowed) {
    const given = source && source.project && typeof source.project === "object" ? source.project : null;
    const project = given || (await readProject(source && source.kv, projectId));
    allowed = keepsSellingFlagOn(project, guideId, projectId);
  }
  if (!allowed) return false;
  const data = ticketData === undefined ? await guideTicketFeed(api, guideId) : ticketData;
  return Boolean(data && Array.isArray(data.results) && data.results.length);
}

// The storefront must show nothing for this Guide event.
// project: the page record the caller already read from KV for projectId
// (saves a second read); otherwise it is read here.
export async function isHiddenGuideEvent(env, guideId, projectId = "", project = null) {
  const api = guideApiBase(env);
  if (!(await guideDetailMissing(api, guideId))) return false;
  const known = project && typeof project === "object" && projectId ? { ...project, id: String(projectId) } : null;
  const source = known ? { project: known } : { kv: env && env.OVERRIDES };
  return !(await keepsSellingWhileHidden(api, guideId, projectId, undefined, source));
}

// A Guide event's public detail, or null when it is missing, fails or times out.
export async function guideEventDetail(api, guideId) {
  try {
    const resp = await fetch(`${api}/events/details/${guideId}/`, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!resp.ok) {
      await discardBody(resp);
      return null;
    }
    return await resp.json();
  } catch {
    return null;
  }
}

// A Guide event's public ticket feed, or null when it fails or takes longer
// than the check timeout (a slow Guide never holds a page response).
export async function guideTicketFeed(api, guideId) {
  try {
    const resp = await fetch(`${api}/ticket/purchase/tickets/${guideId}/?include_choice_addons=1`, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!resp.ok) {
      await discardBody(resp);
      return null;
    }
    return await resp.json();
  } catch {
    return null;
  }
}
