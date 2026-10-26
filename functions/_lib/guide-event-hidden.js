// When Otra Guide answers 404 for an event detail, the event is gone or hidden
// from anonymous visitors, and the storefront shows nothing for it: no page, no
// draft page, no page edits and no homepage or search card. Only an explicit
// 404 counts; an outage or any other error never hides a page.

import { isOtraGuideId } from "./page-override.js";

const API = "https://otraguide.com/api";
const UPSTREAM_TTL = 300;
// A slow Guide never holds a page back: past this, the answer is "not missing".
const CHECK_TIMEOUT_MS = 4000;

// Guide id -> the one published project that may keep selling while its Guide
// detail is hidden, as long as its public ticket feed is live.
export const HIDDEN_DETAIL_EXCEPTIONS = Object.freeze({
  "8088": "draft-1791253678425-26c548a5",
  "8266": "draft-1792794458964-79d36de9",
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

// True when the exception above applies: the exact project, and a live feed.
export async function keepsSellingWhileHidden(api, guideId, projectId, ticketData) {
  if (!projectId || HIDDEN_DETAIL_EXCEPTIONS[String(guideId)] !== String(projectId)) return false;
  const data = ticketData === undefined ? await guideTicketFeed(api, guideId) : ticketData;
  return Boolean(data && Array.isArray(data.results) && data.results.length);
}

// The storefront must show nothing for this Guide event.
export async function isHiddenGuideEvent(env, guideId, projectId = "") {
  const api = guideApiBase(env);
  if (!(await guideDetailMissing(api, guideId))) return false;
  return !(await keepsSellingWhileHidden(api, guideId, projectId));
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
