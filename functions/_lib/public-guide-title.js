// Anonymous title authority: the existing public Guide detail endpoint only.
// No staff token, local title fallback, shared memo across isolates, or KV write.
import { guideApiBase } from "./guide-event-hidden.js";
const reads = new WeakMap();
const TITLE_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 8000;
// Process-local fallback for Node production (droplet). Cloudflare Workers can
// also use caches.default when present. Never shares across requests via KV.
// Failures (outage/timeout/malformed) are kept only for callers that opt in
// (homepage cards), so a Guide slowdown is not re-awaited on every request.
const processCache = new Map();

function cacheGet(id, acceptFailure) {
  const hit = processCache.get(String(id));
  if (!hit) return null;
  if (Date.now() > hit.expires) { processCache.delete(String(id)); return null; }
  if (hit.failure && !acceptFailure) return null;
  return hit.value;
}
function cacheSet(id, value, ttlMs, failure = false) {
  const prev = processCache.get(String(id));
  // A failure never evicts a still-fresh definitive answer.
  if (failure && prev && !prev.failure && Date.now() <= prev.expires) return;
  processCache.set(String(id), { expires: Date.now() + ttlMs, value, failure });
}

// options.timeoutMs: bounded Guide wait (default 8s).
// options.failureCacheMs: >0 reuses a recent failure for that long instead of
// waiting on Guide again (homepage/search cards). Page routes leave it unset.
export async function readPublicGuideTitle(context, id, { timeoutMs = DEFAULT_TIMEOUT_MS, failureCacheMs = 0 } = {}) {
  if (!/^\d+$/.test(String(id || ""))) return { status: 404, title: "" };
  let memo = reads.get(context);
  if (!memo) { memo = new Map(); reads.set(context, memo); }
  if (!memo.has(String(id))) memo.set(String(id), (async () => {
    const cached = cacheGet(id, failureCacheMs > 0);
    if (cached) return cached;
    const cacheKey = `https://title-cache.otratickets.internal/public-guide-title/${id}`;
    try {
      const cache = globalThis.caches && globalThis.caches.default;
      if (cache && typeof cache.match === "function") {
        const hit = await cache.match(cacheKey);
        if (hit) {
          const value = await hit.json();
          cacheSet(id, value, TITLE_CACHE_TTL_MS);
          return value;
        }
      }
    } catch { /* ignore cache read failures */ }
    let value;
    try {
      const response = await fetch(`${guideApiBase(context.env)}/events/details/${id}/`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) value = { status: response.status === 404 ? 404 : 502, title: "" };
      else {
        const data = await response.json();
        if (String(data?.id) !== String(id) || typeof data?.title !== "string" || !data.title.trim())
          value = { status: 502, title: "" };
        else value = { status: 200, title: data.title };
      }
    } catch { value = { status: 502, title: "" }; }
    // Cache definitive answers (200/404) for 60s; failures only process-local
    // and only served back to callers that opted in.
    if (value.status === 200 || value.status === 404) {
      cacheSet(id, value, TITLE_CACHE_TTL_MS);
      try {
        const cache = globalThis.caches && globalThis.caches.default;
        if (cache && typeof cache.put === "function") {
          await cache.put(cacheKey, new Response(JSON.stringify(value), {
            headers: { "content-type": "application/json", "cache-control": `public, max-age=${TITLE_CACHE_TTL_MS / 1000}` },
          }));
        }
      } catch { /* ignore cache write failures */ }
    } else if (failureCacheMs > 0) {
      cacheSet(id, value, failureCacheMs, true);
    }
    return value;
  })());
  return memo.get(String(id));
}

// After a staff rename: drop this event's cached public answer so the next
// anonymous read asks Guide again (best effort; the TTL bounds it anyway).
export async function forgetPublicGuideTitle(id) {
  processCache.delete(String(id));
  try {
    const cache = globalThis.caches && globalThis.caches.default;
    if (cache && typeof cache.delete === "function") {
      await cache.delete(`https://title-cache.otratickets.internal/public-guide-title/${id}`);
    }
  } catch { /* ignore */ }
}

export function clearPublicGuideTitleCache() {
  processCache.clear();
}
