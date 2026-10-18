// Refuse cross-site sign-in and sign-out requests. Browsers always send Origin
// on cross-site POSTs; Sec-Fetch-Site covers the rare request without one.

import { json } from "../admin/api/_auth.js";

const ALLOWED_ORIGINS = new Set(["https://otratickets.com", "https://www.otratickets.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const OK_FETCH_SITES = new Set(["same-origin", "none"]);

function isAllowedOrigin(origin, requestUrl) {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname) && LOCAL_HOSTS.has(requestUrl.hostname);
  } catch {
    return false;
  }
}

export function rejectCrossSite(request, { requireJson = false } = {}) {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (!isAllowedOrigin(origin, new URL(request.url))) return json({ error: "forbidden" }, 403);
  } else {
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && !OK_FETCH_SITES.has(site)) return json({ error: "forbidden" }, 403);
  }
  if (requireJson) {
    const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return json({ error: "unsupported media type" }, 415);
  }
  return null;
}
