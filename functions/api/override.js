// Cloudflare Pages Function: GET /api/override?id=<eventId>
//
// Public read-only override endpoint for hand-built pages that do not render
// through /api/event. Admin writes stay behind /admin/api/overrides.

import { resolvePageOverride } from "../_lib/page-override.js";
import { checkStaff } from "../admin/api/_auth.js";
import { requestToken } from "../_lib/session.js";
import { guideApiBase, guideDetailMissing, isHiddenGuideEvent, keepsSellingWhileHidden } from "../_lib/guide-event-hidden.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!/^(?:\d+|draft-[a-zA-Z0-9-]+)$/.test(id)) return json({ error: "invalid id" }, 400);

  if (!context.env.OVERRIDES) return json({ override: null });

  try {
    // A page whose Otra Guide event answers 404 shows nothing, edits included.
    // The Guide check runs alongside the KV read so pages don't wait longer.
    const api = guideApiBase(context.env);
    const numeric = /^\d+$/.test(id);
    const [{ override, draftId }, missing] = await Promise.all([
      resolvePageOverride(context.env.OVERRIDES, id),
      numeric ? guideDetailMissing(api, id) : false,
    ]);
    if (!override || typeof override !== "object") return json({ override: null });
    const hidden = numeric
      ? missing && !(await keepsSellingWhileHidden(api, id, draftId))
      : await draftFollowsHiddenEvent(context.env, id);
    if (hidden && !(await isStaffRequest(context))) return json({ override: null });
    const rawAccent = typeof override.accentColor === "string" ? override.accentColor.trim() : "";
    return json({
      override: {
        description: typeof override.description === "string" ? override.description : "",
        image: typeof override.image === "string" ? override.image : "",
        checkoutEventId: typeof override.checkoutEventId === "string" && /^\d+$/.test(override.checkoutEventId) ? override.checkoutEventId : "",
        accentColor: /^#[0-9A-Fa-f]{6}$/.test(rawAccent) ? rawAccent.toLowerCase() : "",
        fields: normalizeFields(override.fields),
        updatedAt: typeof override.updatedAt === "string" ? override.updatedAt : null,
      },
    });
  } catch {
    return json({ error: "could not load override" }, 500);
  }
}

// Staff (the admin editor preview) keep seeing the edits of hidden events.
async function isStaffRequest(context) {
  const token = requestToken(context.request);
  return token ? checkStaff(token, context.env) : false;
}

async function draftFollowsHiddenEvent(env, draftId) {
  let guideId = "";
  try {
    const project = await env.OVERRIDES.get(`site-event:${draftId}`, "json");
    guideId = project && typeof project === "object" ? String(project.otraGuideId || "") : "";
  } catch {
    guideId = "";
  }
  return /^\d+$/.test(guideId) ? isHiddenGuideEvent(env, guideId, draftId) : false;
}

function normalizeFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const fields = {};
  for (const [key, field] of Object.entries(raw)) {
    if (typeof key !== "string" || !field || typeof field !== "object") continue;
    if (field.type !== "text" && field.type !== "image" && field.type !== "remove") continue;
    fields[key] = {
      type: field.type,
      value: typeof field.value === "string" ? field.value : "",
    };
  }
  return fields;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
