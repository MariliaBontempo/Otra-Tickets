// When Otra Guide answers 404 for an event detail, the event is gone or hidden
// from anonymous visitors, and the storefront shows nothing for it: no page, no
// draft page, no page edits and no homepage or search card. Only an explicit
// 404 counts; an outage or any other error never hides a page.

const API = "https://otraguide.com/api";
const UPSTREAM_TTL = 300;

// Guide id -> the one published project that may keep selling while its Guide
// detail is hidden, as long as its public ticket feed is live.
export const HIDDEN_DETAIL_EXCEPTIONS = Object.freeze({
  "8088": "draft-1791253678425-26c548a5",
});

export function guideApiBase(env) {
  return String((env && env.OTRA_API_URL) || API).replace(/\/$/, "");
}

export function isGuideId(value) {
  return /^\d+$/.test(String(value || ""));
}

export async function guideDetailMissing(api, guideId) {
  if (!isGuideId(guideId)) return false;
  try {
    const resp = await fetch(`${api}/events/details/${guideId}/`, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
    });
    return resp.status === 404;
  } catch {
    return false;
  }
}

// True when the exception above applies: the exact project, and a live feed.
export async function keepsSellingWhileHidden(api, guideId, projectId, ticketData) {
  if (!projectId || HIDDEN_DETAIL_EXCEPTIONS[String(guideId)] !== String(projectId)) return false;
  const data = ticketData === undefined ? await ticketFeed(api, guideId) : ticketData;
  return Boolean(data && Array.isArray(data.results) && data.results.length);
}

// The storefront must show nothing for this Guide event.
export async function isHiddenGuideEvent(env, guideId, projectId = "") {
  const api = guideApiBase(env);
  if (!(await guideDetailMissing(api, guideId))) return false;
  return !(await keepsSellingWhileHidden(api, guideId, projectId));
}

async function ticketFeed(api, guideId) {
  try {
    const resp = await fetch(`${api}/ticket/purchase/tickets/${guideId}/?include_choice_addons=1`, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}
