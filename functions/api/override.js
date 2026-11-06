import { readPublicGuideTitle } from "../_lib/public-guide-title.js";
import { guideTitleIdForPage } from "../_lib/page-override.js";
import { ownedGuideTitleId, withoutTitleOverride, TITLE_FIELD } from "../_lib/title-ownership.js";
import { readGuideTitle } from "../admin/api/_event-title.js";
// Cloudflare Pages Function: GET /api/override?id=<eventId>
//
// Public read-only override endpoint for hand-built pages that do not render
// through /api/event. Admin writes stay behind /admin/api/overrides.

import { findBoundProjects, resolvePageOverride } from "../_lib/page-override.js";
import { allowsDraftOnlyRemovals, withoutDraftOnlyRemovals } from "../_lib/draft-only-sections.js";
import { isHeroMetaTextKey } from "../_lib/schedule-line.js";
import { heroMetaItemText } from "../_lib/hero-meta-text.js";
import { normalizeRichTextField, normalizeRichHeroMeta, normalizeRichInfoField, richTextAllowedForField } from "../_lib/rich-text.js";
import { checkStaff } from "../admin/api/_auth.js";
import { requestToken } from "../_lib/session.js";
import { guideApiBase, guideDetailMissing, isHiddenGuideEvent, keepsSellingWhileHidden } from "../_lib/guide-event-hidden.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!/^(?:\d+|draft-[a-zA-Z0-9-]+)$/.test(id)) return json({ error: "invalid id" }, 400);

  // No KV binding: no page edits and no known ownership. Hand-built pages keep
  // their static content (never blanked for a config/outage problem).
  if (!context.env.OVERRIDES) return json({ override: null });

  // Known once resolved, so a later failure on an owned page still says the
  // Guide title is unavailable instead of leaving a static/legacy H1 visible.
  let titleId = "";
  try {
    // A page whose Otra Guide event answers 404 shows nothing, edits included.
    // The Guide check runs alongside the KV read so pages don't wait longer.
    const api = guideApiBase(context.env);
    const numeric = /^\d+$/.test(id);
    // One bound-project scan serves both title ownership and the admin-only
    // gate for numeric pages.
    const [{ override: storedOverride, draftId }, missing, bound] = await Promise.all([
      resolvePageOverride(context.env.OVERRIDES, id),
      numeric ? guideDetailMissing(api, id) : false,
      numeric ? findBoundProjects(context.env.OVERRIDES, id) : null,
    ]);
    titleId = numeric
      ? ownedGuideTitleId(bound.published || bound.latest)
      : await guideTitleIdForPage(context.env.OVERRIDES, id);
    // Staff is asked once (memoized) and only by the gates below.
    let staffPromise = null;
    const staffCheck = () => (staffPromise ||= isStaffRequest(context));
    // Even a manual page with no prior overrides needs a response-only title
    // projection in staff preview; an absent KV document is not a title source.
    const override = storedOverride && typeof storedOverride === "object" ? storedOverride
      : titleId ? { fields: {} } : null;
    if (!override) return json({ override: null });
    const hidden = numeric
      ? missing && !(await keepsSellingWhileHidden(api, id, draftId, undefined, { kv: context.env.OVERRIDES }))
      : await draftFollowsHiddenEvent(context.env, id);
    if (hidden && !(await staffCheck())) return json({ override: null, ...(titleId ? { guideTitleHidden: true } : {}) });
    // Private/unpublished owned projects must not leak edits via this parallel API.
    if (numeric && bound.published?.adminOnly === true && !(await staffCheck())) {
      return json({ override: null, ...(titleId ? { guideTitleHidden: true } : {}) });
    }
    if (!numeric) {
      const project = await context.env.OVERRIDES.get(`site-event:${id}`, "json");
      if ((project?.adminOnly === true || (titleId && project?.status !== "published")) && !(await staffCheck())) {
        return json({ override: null, ...(titleId ? { guideTitleHidden: true } : {}) });
      }
    }
    const staff = titleId ? await staffCheck() : false;
    const rawAccent = typeof override.accentColor === "string" ? override.accentColor.trim() : "";
    // Before You Go can be hidden only on an unpublished draft: a live page
    // (Otra Guide id or published draft) always keeps it.
    const draftOnlyOk = await allowsDraftOnlyRemovals(context.env.OVERRIDES, id);
    let rawFields = (draftOnlyOk ? override.fields : withoutDraftOnlyRemovals(override.fields)) || {};
    // A staff preview's public field projection must not overwrite the fresh
    // API title with a legacy H1. This is response-only, never a KV title copy.
    let guideTitle = "";
    if (titleId) {
      const previousTitleField = rawFields[TITLE_FIELD];
      rawFields = withoutTitleOverride({ fields: rawFields }).fields;
      try {
        const current = staff
          ? await readGuideTitle(context, requestToken(context.request), titleId)
          : await readPublicGuideTitle(context, titleId);
        if (!staff && current.status === 404) return json({ override: null, guideTitleHidden: true });
        if (!current.title) throw new Error("public Guide title unavailable");
        guideTitle = current.title;
        // Response-only: plain Guide title, plus style-only html when it still matches.
        let titleField = { type: "text", value: guideTitle };
        if (previousTitleField && typeof previousTitleField.html === "string" && previousTitleField.html) {
          const rich = normalizeRichTextField("", previousTitleField.html);
          if (rich.html && rich.value.trim() === guideTitle) {
            titleField = { type: "text", value: guideTitle, html: rich.html };
          }
        }
        rawFields[TITLE_FIELD] = titleField;
      } catch (error) {
        return json({ error: "Could not refresh Guide title. Reload to retry.", override: null, guideTitleUnavailable: true }, 502);
      }
    }
    return json({
      override: {
        ...(guideTitle ? { guideTitle } : {}),
        description: typeof override.description === "string" ? override.description : "",
        image: typeof override.image === "string" ? override.image : "",
        checkoutEventId: typeof override.checkoutEventId === "string" && /^\d+$/.test(override.checkoutEventId) ? override.checkoutEventId : "",
        accentColor: /^#[0-9A-Fa-f]{6}$/.test(rawAccent) ? rawAccent.toLowerCase() : "",
        fields: normalizeFields(rawFields),
        // Sent only on an unpublished draft, so live answers keep their shape.
        ...(draftOnlyOk ? { draftOnlyRemovals: true } : {}),
        updatedAt: typeof override.updatedAt === "string" ? override.updatedAt : null,
      },
    });
  } catch {
    return json({ error: "could not load override", ...(titleId ? { guideTitleUnavailable: true } : {}) }, 500);
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
    const value = typeof field.value === "string" ? field.value : "";
    fields[key] = {
      type: field.type,
      // A hero line edit reads like the card: "Days · times".
      value: field.type === "text" && isHeroMetaTextKey(key) ? heroMetaItemText(value) : value,
    };
    // Pencil rich text, sanitized again on the way out.
    if (field.type === "text" && typeof field.html === "string" && field.html && richTextAllowedForField(key, fields[key])) {
      const rich = normalizeRichTextField(value, field.html);
      if (rich.html) fields[key] = { type: "text", ...(isHeroMetaTextKey(key) ? normalizeRichHeroMeta(rich) : rich) };
    }
    if (field.type === "text") {
      const richInfo = normalizeRichInfoField(value, field.htmlParts);
      if (richInfo) fields[key] = { type: "text", ...richInfo };
    }
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
