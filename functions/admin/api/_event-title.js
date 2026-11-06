// Guide-first rename, NOT a post-save synchronization hook.
import { otraFetch } from "./_auth.js";
import { isOtraGuideId, guideTitleIdForPage } from "../../_lib/page-override.js";
import { forgetPublicGuideTitle } from "../../_lib/public-guide-title.js";
import { ownedGuideTitleId, withoutLocalProjectTitle, withoutTitleOverride, overrideHasDurableTitleCopy } from "../../_lib/title-ownership.js";
import { liveSlugBase, persistedFrozenSlug } from "../../_lib/event-slug.js";
import { invalidatePublicFeed } from "../../_lib/homepage-feed.js";

export function normalizeGuideTitle(value) {
  if (typeof value !== "string") throw new Error("title must be a string");
  const title = value.trim();
  if (!title) throw new Error("title is required");
  if ([...title].length > 100) throw new Error("title must be at most 100 characters");
  // Event.title is plain text. Rich-text callers must send their plain-text
  // projection, never persist HTML as an alternate local event title.
  if (/<[^>]*>/.test(title) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(title)) throw new Error("title must be plain text");
  return title;
}

export const guideTitleTarget = guideTitleIdForPage;

export async function writeGuideTitle(context, token, id, value) {
  const title = normalizeGuideTitle(value);
  if (!isOtraGuideId(id)) throw new Error("invalid Guide event id");
  const data = await otraFetch(context, token, `/otra-tickets/media/event-title/${id}/`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }), timeoutMs: 15000,
  });
  if (!data || String(data.eventId) !== String(id) || typeof data.title !== "string" ||
      data.title !== title || typeof data.changed !== "boolean") throw new Error("invalid Guide title response; reload and retry");
  // Even if subsequent local metadata cleanup fails, a fresh feed must not
  // keep the old Guide title. No local title is ever written as fallback.
  await invalidatePublicFeed(context.env.OVERRIDES);
  await forgetPublicGuideTitle(id);
  return data;
}

export function projectForStorage(project) {
  if (!ownedGuideTitleId(project)) return project;
  // Mint frozenSlug only at first publish. Drafts must keep renames free to
  // change the eventual public URL. Exception: an unlisted draft already has
  // an admin-reserved short link in frozenSlug — keep that reservation.
  const next = { ...project };
  if (project.status === "published" || project.publishedAt) {
    next.frozenSlug = persistedFrozenSlug(project) || liveSlugBase(project);
  } else if (project.unlisted && persistedFrozenSlug(project)) {
    next.frozenSlug = persistedFrozenSlug(project);
  } else {
    delete next.frozenSlug;
  }
  return withoutLocalProjectTitle(next);
}

export async function putTitleSafeProject(kv, project, { guidePlain } = {}) {
  const stored = projectForStorage(project);
  const key = `site-event:${project.id}`;
  const prev = await kv.get(key, "json");
  if (JSON.stringify(prev) !== JSON.stringify(stored)) {
    await kv.put(key, JSON.stringify(stored));
  }
  if (!ownedGuideTitleId(project)) return;
  // Binding a previously OT-only draft removes its old title field too.
  // Style-only html that still matches the Guide title may remain.
  for (const prefix of ["event:", "override:"]) {
    const docKey = `${prefix}${project.id}`;
    const doc = await kv.get(docKey, "json");
    if (!doc) continue;
    const cleaned = withoutTitleOverride(doc, { keepStyleMatching: guidePlain });
    if (JSON.stringify(doc) !== JSON.stringify(cleaned)) await kv.put(docKey, JSON.stringify(cleaned));
  }
}

export async function discardLinkedTitleCopies(kv, guideId, { guidePlain } = {}) {
  // Use a full scan, not only latest/published: an older draft must not restore
  // a stale title when edited or republished later. Skip writes when already clean.
  let cursor;
  do {
    const page = await kv.list({ prefix: "site-event:", cursor });
    for (const key of page.keys || []) {
      const raw = await kv.get(key.name, "json");
      const project = raw && typeof raw === "object" ? { ...raw, id: raw.id || key.name.slice("site-event:".length) } : raw;
      if (ownedGuideTitleId(project) !== String(guideId)) continue;
      const id = project.id || key.name.slice("site-event:".length);
      const needsProjectClean = overrideHasDurableTitleCopy(project) ||
        (project.claudeDesign && overrideHasDurableTitleCopy(project.claudeDesign)) ||
        (project.design && overrideHasDurableTitleCopy(project.design)) ||
        (!(project.status === "published" || project.publishedAt) && project.frozenSlug);
      let needsDocClean = false;
      for (const prefix of ["event:", "override:"]) {
        const doc = await kv.get(`${prefix}${id}`, "json");
        if (doc && overrideHasDurableTitleCopy(doc)) { needsDocClean = true; break; }
      }
      if (!needsProjectClean && !needsDocClean) continue;
      await putTitleSafeProject(kv, { ...project, id }, { guidePlain });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  // The canonical page can belong to a borrowed published project while an
  // owned draft also uses the same Guide id. Do not erase that borrowed page's
  // legitimate OT-only title when the owned draft is renamed.
  if (await guideTitleTarget(kv, guideId)) {
    for (const prefix of ["event:", "override:"]) {
      const docKey = `${prefix}${guideId}`;
      const doc = await kv.get(docKey, "json");
      if (!doc || !overrideHasDurableTitleCopy(doc)) continue;
      const cleaned = withoutTitleOverride(doc, { keepStyleMatching: guidePlain });
      if (JSON.stringify(doc) !== JSON.stringify(cleaned)) await kv.put(docKey, JSON.stringify(cleaned));
    }
  }
}

// Request-local memo only: never shared across requests, users, KV or edge cache.
const titleReads = new WeakMap();
export async function readGuideTitle(context, token, id, { fresh = false } = {}) {
  if (!token || !isOtraGuideId(id)) throw new Error("staff Guide title session required");
  let reads = titleReads.get(context);
  if (!reads) { reads = new Map(); titleReads.set(context, reads); }
  const key = `${token}:${id}`;
  if (fresh) reads.delete(key);
  if (!reads.has(key)) reads.set(key, (async () => {
    const data = await otraFetch(context, token, `/otra-tickets/media/event-slug/${id}/`, {
      method: "GET", cache: "no-store", timeoutMs: 8000,
    });
    if (!data || String(data.id) !== String(id) || typeof data.title !== "string" || !data.title.trim())
      throw new Error("Guide title unavailable in event-slug response");
    return { eventId: Number(id), title: data.title };
  })());
  return reads.get(key);
}

export async function guideTitleForResponse(context, token, id, { saved = false, fresh = false } = {}) {
  if (!id) return {};
  try { return { guideTitle: await readGuideTitle(context, token, id, { fresh }) }; }
  catch (error) {
    return { guideTitle: null, guideTitleUnavailable: true,
      warning: `${saved ? "Title saved in Guide, but title refresh failed" : "Could not refresh Guide title"}: ${error.message}. Reload to retry.` };
  }
}

// Response projection only. Never pass hydrated title to a KV/cache writer.
export async function hydrateProjectTitle(context, token, project) {
  const id = ownedGuideTitleId(project);
  if (!id) return project;
  const result = await guideTitleForResponse(context, token, id);
  const clean = withoutLocalProjectTitle(project);
  return { ...clean, title: result.guideTitle?.title || "", ...result };
}

export async function hydrateProjectTitles(context, token, projects) {
  // Bound concurrency keeps large admin lists from bursting Calendar connections.
  const result = new Array(projects.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, projects.length) }, async () => {
    while (cursor < projects.length) { const index = cursor++; result[index] = await hydrateProjectTitle(context, token, projects[index]); }
  }));
  return result;
}
