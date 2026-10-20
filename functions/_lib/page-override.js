// One resolver for the page edits of an event.
//
// A draft keeps its edits under event:<draftId>. Once the draft is published
// the admin edits the page under its Otra Guide id, so new edits land in
// event:<otraGuideId>. Both documents describe the same page, so every
// reader (public page, admin editor, homepage feed, clone, photo sync) goes
// through resolvePageOverride and sees the draft edits with the later edits
// on top.
//
// A save made from the merged view stamps draftEditsFrom with the draft id.
// That document already carries the draft edits (and any deliberate
// removals), so it is used as is. The admin refuses saves on the draft id
// of a published bound draft, so its draft document stops changing. See
// coversDraft for event documents saved before this resolver existed.

export const TOP_LEVEL_KEYS = ["description", "image", "checkoutEventId", "accentColor"];

// Written on every live page document saved by this version of the admin.
// A document without it was saved before the merged view existed.
export const PAGE_EDITS_VERSION = 2;

export function isLegacyDoc(doc) {
  return Boolean(doc && !(Number(doc.pageEditsVersion) >= PAGE_EDITS_VERSION) && !doc.draftEditsFrom);
}

export function isOtraGuideId(id) {
  return /^\d+$/.test(String(id || ""));
}

async function getJson(kv, key) {
  try {
    const value = await kv.get(key, "json");
    if (typeof value !== "string") return value;
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function readOverrideDoc(kv, id) {
  if (!kv || !id) return null;
  const doc = (await getJson(kv, `event:${id}`)) || (await getJson(kv, `override:${id}`));
  return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
}

// True for a published site event bound to an Otra Guide event: its live
// page lives under the Otra Guide id.
export function isPublishedBound(project) {
  return Boolean(
    project &&
      typeof project === "object" &&
      !project.archivedAt &&
      project.status === "published" &&
      isOtraGuideId(project.otraGuideId)
  );
}

// Site events bound to an Otra Guide id, archived ones skipped. Returns the
// most recently created one (the design an event page renders) and the most
// recently created published one (whose draft edits feed the live page).
export async function findBoundProjects(kv, id) {
  const found = { latest: null, published: null };
  if (!kv || typeof kv.list !== "function" || !isOtraGuideId(id)) return found;
  const newer = (a, b) => !b || String(a.createdAt || "") > String(b.createdAt || "");
  let cursor;
  do {
    const page = await kv.list({ prefix: "site-event:", cursor });
    for (const key of page.keys || []) {
      const project = await getJson(kv, key.name);
      if (!project || typeof project !== "object" || project.archivedAt) continue;
      if (String(project.otraGuideId || "") !== String(id)) continue;
      if (!project.id) project.id = key.name.replace(/^site-event:/, "");
      if (newer(project, found.latest)) found.latest = project;
      if (project.status === "published" && newer(project, found.published)) found.published = project;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return found;
}

function stamp(doc) {
  const value = doc && typeof doc.updatedAt === "string" ? Date.parse(doc.updatedAt) : NaN;
  return Number.isFinite(value) ? value : 0;
}

function hasValue(value) {
  return typeof value === "string" ? value.trim() !== "" : value != null;
}

function fieldsOf(doc) {
  return doc && doc.fields && typeof doc.fields === "object" && !Array.isArray(doc.fields) ? doc.fields : {};
}

// Per key merge of two override documents. The newer document wins every key
// both of them set; keys only one of them sets are kept. The result keeps the
// event document identity. Ties (or missing dates) go to the event document.
export function mergeOverrideDocs(draftDoc, eventDoc) {
  if (!draftDoc) return eventDoc || null;
  if (!eventDoc) return draftDoc;
  const eventIsNewer = stamp(eventDoc) >= stamp(draftDoc);
  const [older, newer] = eventIsNewer ? [draftDoc, eventDoc] : [eventDoc, draftDoc];
  const merged = { ...eventDoc, fields: { ...fieldsOf(older), ...fieldsOf(newer) } };
  for (const key of TOP_LEVEL_KEYS) {
    merged[key] = hasValue(newer[key]) ? newer[key] : hasValue(older[key]) ? older[key] : "";
  }
  merged.updatedAt = stamp(newer) ? newer.updatedAt : eventDoc.updatedAt || draftDoc.updatedAt || null;
  return merged;
}

// True when the event document is served as is, without the draft edits:
// - it was saved from a view that already held every edit of this draft
//   (draftEditsFrom), and the draft has not changed since; or
// - it is a legacy document (saved before the merged view existed, so no
//   pageEditsVersion and no draftEditsFrom) at least as new as the draft
//   document. Those pages keep rendering exactly as they did, so shipping
//   the merge changes no live page; restoring draft edits such a page hid is
//   a deliberate, separate step.
// Anything else is merged: a draft document newer than the event document,
// or a current document saved without this draft (for example an edit on
// the live page before a draft bound to that event was published).
export function coversDraft(eventDoc, draftId, draftDoc) {
  if (!eventDoc || !draftId) return false;
  if (draftDoc && stamp(draftDoc) > stamp(eventDoc)) return false;
  if (eventDoc.draftEditsFrom === draftId) return true;
  return isLegacyDoc(eventDoc);
}

// Returns { override, draftId, fromDraft } for a page id. draftId is the
// published bound draft whose edits were considered ("" when none);
// fromDraft is true when the override carries edits read from that draft
// document (the draft alone, or merged under the event document).
//
// options.draftId: pass the bound draft id when the caller already knows it
// (a string, "" meaning no bound draft), to skip the site event scan. Leave
// it out to look the published bound draft up.
export async function resolvePageOverride(kv, id, options = {}) {
  const eventDoc = await readOverrideDoc(kv, id);
  const asIs = (draftId) => ({ override: eventDoc, draftId, fromDraft: false });
  if (!isOtraGuideId(id)) return asIs("");
  let draftId;
  if (typeof options.draftId === "string") {
    draftId = options.draftId;
  } else {
    const { published } = await findBoundProjects(kv, id);
    draftId = published ? String(published.id || "") : "";
  }
  if (!draftId) return asIs("");
  const draftDoc = await readOverrideDoc(kv, draftId);
  if (!draftDoc) return asIs(draftId);
  if (coversDraft(eventDoc, draftId, draftDoc)) return asIs(draftId);
  return { override: mergeOverrideDocs(draftDoc, eventDoc), draftId, fromDraft: true };
}
