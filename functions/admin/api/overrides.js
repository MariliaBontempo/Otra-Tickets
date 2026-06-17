// Cloudflare Pages Function: GET/PUT /admin/api/overrides?id=<eventId>
//
// Read/write the per-event content overrides (description + image) used by the
// public pages. Stored in the KV namespace bound as OVERRIDES, keyed by event
// id. Every call is gated on a valid Otra Guide staff/admin token.
//
// GET  -> { override: { description?, image? } | null }
// PUT body { description?, image? } -> { ok: true, override }

import { requireStaff, json } from "./_auth.js";

const KEY = (id) => `override:${id}`;

function getId(request) {
  const id = (new URL(request.url).searchParams.get("id") || "").trim();
  return /^\d+$/.test(id) ? id : null;
}

export async function onRequestGet(context) {
  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  if (!(await requireStaff(context.request))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const raw = await kv.get(KEY(id));
  return json({ override: raw ? JSON.parse(raw) : null });
}

export async function onRequestPut(context) {
  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  if (!(await requireStaff(context.request))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  // Whitelist the fields a staff member may override, and drop empty ones so
  // the public side falls back to the live Otra Guide value.
  const override = {};
  if (typeof body.description === "string" && body.description.trim()) {
    override.description = body.description.trim();
  }
  if (typeof body.image === "string" && body.image.trim()) {
    override.image = body.image.trim();
  }

  if (Object.keys(override).length === 0) {
    await kv.delete(KEY(id));
    return json({ ok: true, override: null });
  }

  override.updatedAt = new Date().toISOString();
  await kv.put(KEY(id), JSON.stringify(override));
  return json({ ok: true, override });
}
