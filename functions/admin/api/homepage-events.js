// Cloudflare Pages Function: GET /admin/api/homepage-events
//
// Staff-only preview of the public homepage feed. Same { events, rows } shape
// as /api/homepage-events, but:
//   * includes KV site events flagged adminOnly
//   * forwards the staff Bearer token to the upstream Otra Guide feed so
//     Django-side staff_only events appear too
//   * never cached (per-auth response)

import { requireStaff, json } from "./_auth.js";
import { buildHomepageFeed } from "../../_lib/homepage-feed.js";

export async function onRequestGet(context) {
  const accessToken = await requireStaff(context.request, context.env);
  if (!accessToken) return json({ error: "unauthorized" }, 401);

  const url = new URL(context.request.url);
  const { events, rows } = await buildHomepageFeed(context, {
    includeAdminOnly: true,
    authToken: accessToken,
    forceFresh: url.searchParams.get("fresh") === "1",
  });
  return json({ events, rows });
}
