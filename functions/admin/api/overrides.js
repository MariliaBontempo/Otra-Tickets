// Cloudflare Pages Function: GET/PUT /admin/api/overrides?id=<eventId>
//
// Staff-only editor API. Overrides live in Cloudflare KV and can target the
// main event description/image plus arbitrary page fields.

import { requireStaff, staffSession, json } from "./_auth.js";
import { actorForAudit, appendAudit, changedOverrideFields } from "./_audit.js";
import { resyncPublishedProjectPhotos } from "./projects.js";
import { allowsDraftOnlyRemovals, withoutDraftOnlyRemovals } from "../../_lib/draft-only-sections.js";
import { PAGE_EDITS_VERSION, TOP_LEVEL_KEYS, isLegacyDoc, isPublishedBound, isOtraGuideId, resolvePageOverride } from "../../_lib/page-override.js";
import { OVERRIDE_CONFLICT_MESSAGE, mergeOverrideSave } from "../../_lib/override-conflict.js";

const KEY = (id) => `event:${id}`;

export async function onRequestGet(context) {
  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  if (!(await requireStaff(context.request, context.env))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  // The editor starts from what the public page shows: for a published
  // draft that is its draft edits with the later edits on top.
  const { override, draftId } = await readOverride(kv, id);
  if (override && draftId) override.draftEditsFrom = draftId;
  // A live page never shows a draft-only hide (Before You Go), so the editor
  // of a live page does not see or carry it either.
  if (override && !(await allowsDraftOnlyRemovals(kv, id))) override.fields = withoutDraftOnlyRemovals(override.fields);
  return json({ override });
}

export async function onRequestPut(context) {
  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  const session = await staffSession(context.request, context.env);
  if (!session) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  // A published bound draft lives under its Otra Guide id. A save on the
  // draft id (an editor tab left open from before publish) would change the
  // edits merged under the live page, so send the editor to the live page.
  if (id.startsWith("draft-")) {
    let project = null;
    try {
      project = await kv.get(`site-event:${id}`, "json");
    } catch {
      project = null;
    }
    if (isPublishedBound(project)) {
      return json({ error: "this draft is published; edit the live page instead", liveId: String(project.otraGuideId) }, 409);
    }
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  const description = normalizeTopValue("description", body.description);
  const image = normalizeTopValue("image", body.image);
  const rawCheckoutEventId = String(body.checkoutEventId ?? "").trim();
  const checkoutEventId = normalizeTopValue("checkoutEventId", body.checkoutEventId);
  const accentColor = normalizeTopValue("accentColor", body.accentColor);
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

  const { override: previous, draftId, fromDraft, coversThisDraft, legacyAsIs } = await readOverride(kv, id);
  const draftOnlyRemovalsOk = await allowsDraftOnlyRemovals(kv, id);
  // Compare against what the editor GET served, so a hide the editor never
  // saw does not count as a change made by someone else.
  const served = previous && !draftOnlyRemovalsOk ? { ...previous, fields: withoutDraftOnlyRemovals(previous.fields) } : previous;
  const saved = mergeOverrideSave(served, { description, image, checkoutEventId, accentColor, fields }, normalizeBase(body.base));
  if (saved.conflictKeys) {
    // Same shape as the GET, so the editor can load it as its new base.
    const current = served && draftId ? { ...served, draftEditsFrom: draftId } : served;
    return json({ error: OVERRIDE_CONFLICT_MESSAGE, conflict: true, conflictKeys: saved.conflictKeys, override: current }, 409);
  }
  const override = {
    id,
    ...saved.override,
    updatedAt: new Date().toISOString(),
  };
  if (draftId && fromDraft) {
    // A client that did not load the merged view (an editor tab opened
    // before this change) sends only what it saw. Keep the draft edits
    // under its changes instead of hiding them. When the page was served as
    // is there is nothing to restore, so its removals stand.
    if (previous && body.draftEditsFrom !== draftId) {
      override.fields = { ...previous.fields, ...override.fields };
      for (const key of TOP_LEVEL_KEYS) {
        if (!override[key] && previous[key]) override[key] = previous[key];
      }
    }
  }
  // This document now holds every edit of the draft. A legacy page served
  // as is (saved before the merged view existed) instead records the one
  // draft whose edits it hides: that draft stays hidden, so the page keeps
  // rendering as before and the edits stay there for a deliberate restore,
  // while any other draft published later is merged.
  // Before You Go is hidden only on unpublished drafts; a save on a live page
  // or published draft drops that hide instead of storing it.
  if (!draftOnlyRemovalsOk) override.fields = withoutDraftOnlyRemovals(override.fields);
  if (draftId && (fromDraft || coversThisDraft)) override.draftEditsFrom = draftId;
  else if (legacyAsIs) override.draftEditsHidden = draftId;
  if (isOtraGuideId(id)) override.pageEditsVersion = PAGE_EDITS_VERSION;
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
  const { override, draftId, fromDraft } = await resolvePageOverride(kv, id);
  const coversThisDraft = Boolean(override && draftId && override.draftEditsFrom === draftId);
  const legacyAsIs = Boolean(
    draftId && !fromDraft && override && !coversThisDraft && (isLegacyDoc(override) || override.draftEditsHidden === draftId)
  );
  return { override: override ? normalizeOverride(override, id) : null, draftId, fromDraft, coversThisDraft, legacyAsIs };
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

// The version and the before values of the keys the editor changed. A
// client that sends no base (an editor tab opened before this check) gets
// null and its save is applied as sent.
function normalizeBase(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawTop = raw.top && typeof raw.top === "object" ? raw.top : {};
  const rawFields = raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields) ? raw.fields : {};
  const top = {};
  for (const key of TOP_LEVEL_KEYS) if (key in rawTop) top[key] = normalizeTopValue(key, rawTop[key]);
  const fields = {};
  for (const [key, field] of Object.entries(rawFields)) fields[key] = normalizeFields({ [key]: field })[key] || null;
  return { updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : null, top, fields };
}

function normalizeTopValue(key, value) {
  if (key === "checkoutEventId") return normalizeCheckoutEventId(value);
  const text = typeof value === "string" ? value.trim() : "";
  if (key === "accentColor") return /^#[0-9A-Fa-f]{6}$/.test(text) ? text.toLowerCase() : "";
  return text;
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
