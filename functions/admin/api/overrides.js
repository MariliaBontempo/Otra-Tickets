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
import { invalidatePublicFeed } from "../../_lib/homepage-feed.js";
import { normalizeRichTextField, normalizeRichInfoField, richTextAllowedForField } from "../../_lib/rich-text.js";

import { TITLE_FIELD, withoutTitleOverride, styleOnlyTitleField, overrideHasDurableTitleCopy } from "../../_lib/title-ownership.js";
import { guideTitleTarget, normalizeGuideTitle, writeGuideTitle, discardLinkedTitleCopies, guideTitleForResponse, readGuideTitle } from "./_event-title.js";

const KEY = (id) => `event:${id}`;

export async function onRequestGet(context) {
  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  const token = await requireStaff(context.request, context.env);
  if (!token) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  // The editor starts from what the public page shows: for a published
  // draft that is its draft edits with the later edits on top.
  const { override, draftId } = await readOverride(kv, id);
  if (override && draftId) override.draftEditsFrom = draftId;
  // A live page never shows a draft-only hide (Before You Go), so the editor
  // of a live page does not see or carry it either.
  if (override && !(await allowsDraftOnlyRemovals(kv, id))) override.fields = withoutDraftOnlyRemovals(override.fields);
  const guideTitleId = await guideTitleTarget(kv, id);
  return json({ override, ...await guideTitleForResponse(context, token, guideTitleId) });
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

  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid body" }, 400);
  const linkedTitleId = await guideTitleTarget(kv, id);
  const titleField = body.fields?.[TITLE_FIELD];
  // Modern clients declare only changed keys in base.fields. Stale full-form
  // saves carrying their old title must NOT rename the Guide event by accident.
  const legacyTitle = linkedTitleId && !body.base
    ? (await resolvePageOverride(kv, id)).override?.fields?.[TITLE_FIELD] : null;
  const unchangedLegacyTitle = legacyTitle?.type === "text" && typeof legacyTitle.value === "string" &&
    typeof titleField?.value === "string" && legacyTitle.value.trim() === titleField.value.trim();
  const titleFieldTouched = linkedTitleId && titleField?.type === "text" &&
    (body.base ? Object.prototype.hasOwnProperty.call(body.base.fields || {}, TITLE_FIELD) : !unchangedLegacyTitle);
  let requestedTitle = "";
  let formatOnlyTitle = false;
  if (titleFieldTouched) {
    try {
      const rich = typeof titleField.html === "string" && titleField.html
        ? normalizeRichTextField(typeof titleField.value === "string" ? titleField.value : "", titleField.html)
        : { value: "", html: "" };
      // Plain renames validate the raw value (rejects non-strings). Style layers
      // validate the plain text rebuilt from html.
      requestedTitle = normalizeGuideTitle(rich.html ? rich.value : titleField.value);
      // Only prefetch Guide title when html is present (format-only candidate).
      // Plain renames must stay upstream-first: POST before any event-slug GET.
      if (rich.html) {
        let currentGuidePlain = "";
        try { currentGuidePlain = (await readGuideTitle(context, session.token, linkedTitleId)).title; }
        catch {
          const baseBefore = body.base?.fields?.[TITLE_FIELD];
          currentGuidePlain = typeof baseBefore?.value === "string" ? baseBefore.value.trim()
            : (typeof legacyTitle?.value === "string" ? legacyTitle.value.trim() : "");
        }
        formatOnlyTitle = Boolean(currentGuidePlain && requestedTitle === currentGuidePlain);
      }
    } catch (error) { return json({ error: error.message }, 400); }
  }
  const titleIntent = titleFieldTouched && !formatOnlyTitle;

  const description = normalizeTopValue("description", body.description);
  const image = normalizeTopValue("image", body.image);
  const rawCheckoutEventId = String(body.checkoutEventId ?? "").trim();
  const checkoutEventId = normalizeTopValue("checkoutEventId", body.checkoutEventId);
  const accentColor = normalizeTopValue("accentColor", body.accentColor);
  let fields = normalizeFields(linkedTitleId ? withoutTitleOverride({ fields: body.fields }).fields : body.fields);
  if (linkedTitleId && titleFieldTouched) {
    const rich = typeof titleField.html === "string" && titleField.html
      ? normalizeRichTextField(titleField.value, titleField.html)
      : { value: requestedTitle, html: "" };
    const style = styleOnlyTitleField(
      { type: "text", value: rich.value || requestedTitle, html: rich.html },
      requestedTitle
    );
    if (style) fields[TITLE_FIELD] = style;
  }
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
  const base = normalizeBase(body.base);
  if (linkedTitleId && base) delete base.fields[TITLE_FIELD];
  const saved = mergeOverrideSave(served, { description, image, checkoutEventId, accentColor, fields }, base);
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
  // base.fields drops TITLE_FIELD for owned conflict avoidance; re-apply the
  // style-only layer after merge so format-only html is not lost.
  if (linkedTitleId && titleFieldTouched && titleField) {
    const rich = typeof titleField.html === "string" && titleField.html
      ? normalizeRichTextField(typeof titleField.value === "string" ? titleField.value : "", titleField.html)
      : { value: requestedTitle, html: "" };
    const style = styleOnlyTitleField(
      { type: "text", value: rich.value || requestedTitle, html: rich.html },
      requestedTitle
    );
    if (style) override.fields = { ...override.fields, [TITLE_FIELD]: style };
  }
  let guideTitle = null;
  if (titleIntent) {
    try {
      guideTitle = await writeGuideTitle(context, session.token, linkedTitleId, requestedTitle);
    } catch (error) {
      // Keep the modal/input open for retry. Do not save a divergent title or
      // claim a local save succeeded while Guide refused the rename.
      return json({ error: `Could not confirm Guide title: ${error.message}. Retry.`, warning: "No local title was saved.", retryable: true }, 502);
    }
  }
  try {
    if (linkedTitleId) {
      let guidePlain = guideTitle?.title || (formatOnlyTitle ? requestedTitle : "");
      if (!guidePlain) {
        try { guidePlain = (await readGuideTitle(context, session.token, linkedTitleId)).title; }
        catch { guidePlain = override.fields?.[TITLE_FIELD]?.value || ""; }
      }
      // Strip durable plain title mirrors; keep style-only html when plain matches Guide.
      override.fields = withoutTitleOverride(override, { keepStyleMatching: guidePlain }).fields;
      if (titleIntent && guideTitle && guideTitle.changed) {
        // Only sweep linked copies when Guide reports the title actually changed.
        await discardLinkedTitleCopies(kv, linkedTitleId, { guidePlain: guideTitle.title });
      }
    }
    await kv.put(KEY(id), JSON.stringify(override));
  } catch (error) {
    return json({ error: guideTitle
      ? "Guide title saved, but local metadata cleanup failed. Reload and retry."
      : "Local metadata could not be saved. Retry.", retryable: true, ...(guideTitle ? { guideTitle } : {}) }, 503);
  }
  await appendAudit(kv, {
    actor: await actorForAudit(session.token, session.role, context.env),
    action: "save",
    pageId: id,
    changedFields: [...changedOverrideFields(previous, override), ...(guideTitle ? ["guide:title"] : [])],
  });
  // Drop the public homepage snapshot so the next /api/homepage-events rebuild
  // picks up renamed titles and new hero photos instead of serving stale cards.
  // invalidatePublicFeed also moves the feed epoch, so a rebuild already in
  // flight cannot write the old cards back.
  await invalidatePublicFeed(kv);

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
  const titleRefresh = linkedTitleId && (guideTitle || formatOnlyTitle)
    ? await guideTitleForResponse(context, session.token, linkedTitleId, { saved: !!guideTitle, fresh: true }) : {};
  if (titleRefresh.guideTitle && guideTitle) titleRefresh.guideTitle.changed = guideTitle.changed;
  const warnings = [photoSyncWarning, titleRefresh.warning].filter(Boolean);
  return json({ override, ...titleRefresh, ...(warnings.length ? { warning: warnings.join(" ") } : {}) });
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
  const normalized = override ? normalizeOverride(override, id) : null;
  const linkedTitleId = await guideTitleTarget(kv, id);
  return { override: linkedTitleId ? withoutTitleOverride(normalized, { keepAnyStyle: true }) : normalized, draftId, fromDraft, coversThisDraft, legacyAsIs };
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
    // Pencil rich text: only the allowed markup is kept, and the plain value
    // is rebuilt from it so the two always match.
    if (type === "text" && typeof field.html === "string" && field.html && richTextAllowedForField(key, fields[key])) {
      const rich = normalizeRichTextField(value, field.html);
      if (rich.html) fields[key] = { type, value: rich.value.trim(), html: rich.html };
    }
    if (field.type === "text") {
      const richInfo = normalizeRichInfoField(value, field.htmlParts);
      if (richInfo) fields[key] = { type: "text", ...richInfo };
    }
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
