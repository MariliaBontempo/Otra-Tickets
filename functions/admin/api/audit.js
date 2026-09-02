// Cloudflare Pages Function: GET /admin/api/audit?id=<pageId>
//
// Staff-only history of override saves and media uploads for one page.

import { staffSession, json } from "./_auth.js";
import { actorForAudit, isAuditPageId, readAudit } from "./_audit.js";

export async function onRequestGet(context) {
  const id = (new URL(context.request.url).searchParams.get("id") || "").trim();
  if (!isAuditPageId(id)) return json({ error: "invalid id" }, 400);
  const session = await staffSession(context.request, context.env);
  if (!session) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const sessionActor = await actorForAudit(session.token, session.role, context.env);
  return json({ entries: await readAudit(kv, id, sessionActor) });
}
