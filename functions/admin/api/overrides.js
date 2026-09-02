// Cloudflare Pages Function: GET/PUT /admin/api/overrides?id=<eventId>
//
// Staff-only editor API. Overrides live in Cloudflare KV and can target the
// main event description/image plus arbitrary page fields.

import { requireStaff, staffSession, json } from "./_auth.js";
import { actorForAudit, appendAudit, changedOverrideFields } from "./_audit.js";
import { resyncPublishedProjectPhotos } from "./projects.js";

const KEY = (id) => `event:${id}`;
const LEGACY_KEY = (id) => `override:${id}`;

export async function onRequestGet(context) {
  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  if (!(await requireStaff(context.request, context.env))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const override = await readOverride(kv, id);
  return json({ override });
}

export async function onRequestPut(context) {
  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  const session = await staffSession(context.request, context.env);
  if (!session) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  const image = typeof body.image === "string" ? body.image.trim() : "";
  const rawCheckoutEventId = String(body.checkoutEventId ?? "").trim();
  const checkoutEventId = normalizeCheckoutEventId(rawCheckoutEventId);
  const rawAccentColor = typeof body.accentColor === "string" ? body.accentColor.trim() : "";
  const accentColor = /^#[0-9A-Fa-f]{6}$/.test(rawAccentColor) ? rawAccentColor.toLowerCase() : "";
  const fields = normalizeFields(body.fields);
  if (description.length > 20000) return json({ error: "description is too long" }, 400);
  if (image && !isAllowedImageUrl(image)) return json({ error: "invalid image url" }, 400);
  if (rawCheckoutEventId && !checkoutEventId) return json({ error: "invalid checkout event id" }, 400);
  for (const field of Object.values(fields)) {
    if (field.type === "text" && field.value.length > 20000) {
      return json({ error: "text field is too long" }, 400);
    }
    if (field.type === "image" && field.value && !isAllowedImageUrl(field.value)) {
      return json({ error: "invalid image url" }, 400);
    }
  }

  const override = {
    id,
    description,
    image,
    checkoutEventId,
    accentColor,
    fields,
    updatedAt: new Date().toISOString(),
  };
  const previous = await readOverride(kv, id);
  await kv.put(KEY(id), JSON.stringify(override));
  await appendAudit(kv, {
    actor: await actorForAudit(session.token, session.role, context.env),
    action: "save",
    pageId: id,
    changedFields: changedOverrideFields(previous, override),
  });
  // Drop the public homepage snapshot so the next /api/homepage-events rebuild
  // picks up renamed titles and new hero photos instead of serving stale cards.
  try {
    await kv.delete("__homepage_feed_snapshot__");
  } catch {
    /* snapshot miss is fine */
  }

  // A photo edit on an already-published event must reach Otra Guide too -
  // publish-time sync alone would leave its gallery stuck at the photos from
  // publish day. Text-only edits skip the round trip, and a sync failure
  // never fails the save (the editor sees a warning instead).
  let photoSyncWarning = "";
  if (photoSignature(previous) !== photoSignature(override)) {
    const accessToken = session.token;
    try {
      await resyncPublishedProjectPhotos(context, accessToken, id, override);
    } catch (error) {
      photoSyncWarning = `photo sync failed: ${error.message}`;
    }
  }
  return json(photoSyncWarning ? { override, warning: photoSyncWarning } : { override });
}

// The photo set Otra Guide cares about: the legacy top-level image plus every
// image-type field, keyed by slot. Order-insensitive within a slot.
function photoSignature(override) {
  if (!override || typeof override !== "object") return "";
  const fields = override.fields && typeof override.fields === "object" ? override.fields : {};
  const parts = Object.entries(fields)
    .filter(([, field]) => field && field.type === "image")
    .map(([key, field]) => `${key}=${field.value || ""}`)
    .sort();
  return `${override.image || ""}|${parts.join("|")}`;
}

async function readOverride(kv, id) {
  const raw = (await kv.get(KEY(id))) || (await kv.get(LEGACY_KEY(id)));
  return raw ? normalizeOverride(JSON.parse(raw), id) : null;
}

function normalizeOverride(raw, id) {
  if (!raw || typeof raw !== "object") return null;
  const rawAccent = typeof raw.accentColor === "string" ? raw.accentColor.trim() : "";
  return {
    id,
    description: typeof raw.description === "string" ? raw.description : "",
    image: typeof raw.image === "string" ? raw.image : "",
    checkoutEventId: normalizeCheckoutEventId(raw.checkoutEventId),
    accentColor: /^#[0-9A-Fa-f]{6}$/.test(rawAccent) ? rawAccent.toLowerCase() : "",
    fields: normalizeFields(raw.fields),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

function normalizeFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const fields = {};
  for (const [key, field] of Object.entries(raw)) {
    if (typeof key !== "string" || key.length > 500) continue;
    if (!field || typeof field !== "object") continue;
    const type = field.type === "image" ? "image" : field.type === "text" ? "text" : field.type === "remove" ? "remove" : "";
    if (!type) continue;
    const value = typeof field.value === "string" ? field.value.trim() : "";
    fields[key] = { type, value };
    // Removal metadata is presentation-only, but retaining it lets the admin
    // offer the right restore control after the iframe element is gone.
    if (type === "remove" && field.kind === "price-card") {
      fields[key].kind = "price-card";
      fields[key].label = typeof field.label === "string" ? field.label.trim().slice(0, 80) : "";
    }
  }
  return fields;
}

function getId(request) {
  const id = (new URL(request.url).searchParams.get("id") || "").trim();
  return /^(?:\d+|draft-[a-zA-Z0-9-]+)$/.test(id) ? id : "";
}

function normalizeCheckoutEventId(value) {
  const id = String(value || "").trim();
  return /^\d+$/.test(id) ? id : "";
}

function isAllowedImageUrl(value) {
  try {
    const url = new URL(value, "https://otratickets.com");
    return (
      url.pathname.startsWith("/override-images/") ||
      url.pathname.startsWith("/override-media/") ||
      url.pathname.startsWith("/uploads/") ||
      /^https?:$/.test(url.protocol)
    );
  } catch {
    return false;
  }
}
