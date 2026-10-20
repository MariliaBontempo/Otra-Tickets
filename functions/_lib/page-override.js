// One resolver for the page edits of an event.
//
// A draft keeps its edits under event:<draftId>. Once the draft is published
// the admin edits the page under its Otra Guide id, so new edits land in
// event:<otraGuideId>. Both documents describe the same page, so every
// reader (public page, admin editor, homepage feed, clone) goes through
// resolvePageOverride and sees the draft edits with the later edits on top.
//
// A save made from the merged view stamps draftEditsFrom with the draft id.
// That document already carries the draft edits (and any deliberate
// removals), so it is used as is until the draft document changes again.

const TOP_LEVEL = ["description", "image", "checkoutEventId", "accentColor"];

export function isOtraGuideId(id) {
  return /^\d+$/.test(String(id || ""));
}

async function getJson(kv, key) {
  const value = await kv.get(key, "json");
  if (typeof value !== "string") return value;
  try {
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

// The site event a public event page renders for an Otra Guide id: the most
// recently created bound project that is not archived.
export async function findProjectByOtraGuideId(kv, id) {
  if (!kv || typeof kv.list !== "function" || !isOtraGuideId(id)) return null;
  let latest = null;
  let cursor;
  do {
    const page = await kv.list({ prefix: "site-event:", cursor });
    for (const key of page.keys || []) {
      const project = await getJson(kv, key.name);
      if (!project || typeof project !== "object" || project.archivedAt || String(project.otraGuideId || "") !== String(id)) continue;
      if (!project.id) project.id = key.name.replace(/^site-event:/, "");
      if (!latest || String(project.createdAt || "") > String(latest.createdAt || "")) latest = project;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return latest;
}

function stamp(doc) {
  const value = doc && typeof doc.updatedAt === "string" ? Date.parse(doc.updatedAt) : NaN;
  return Number.isFinite(value) ? value : 0;
}

function hasValue(value) {
  return typeof value === "string" ? value.trim() !== "" : value != null;
}

// Per key merge of two override documents. The newer document wins every key
// both of them set; keys only one of them sets are kept. The result keeps the
// event document identity.
export function mergeOverrideDocs(draftDoc, eventDoc) {
  if (!draftDoc) return eventDoc || null;
  if (!eventDoc) return draftDoc;
  const eventIsNewer = stamp(eventDoc) >= stamp(draftDoc);
  const [older, newer] = eventIsNewer ? [draftDoc, eventDoc] : [eventDoc, draftDoc];
  const olderFields = older.fields && typeof older.fields === "object" ? older.fields : {};
  const newerFields = newer.fields && typeof newer.fields === "object" ? newer.fields : {};
  const merged = { ...eventDoc, fields: { ...olderFields, ...newerFields } };
  for (const key of TOP_LEVEL) {
    merged[key] = hasValue(newer[key]) ? newer[key] : hasValue(older[key]) ? older[key] : "";
  }
  merged.updatedAt = stamp(newer) ? newer.updatedAt : eventDoc.updatedAt || draftDoc.updatedAt || null;
  return merged;
}

// True when the event document was saved from a view that already held
// every edit of this draft, so it needs no merge.
export function coversDraft(eventDoc, draftId, draftDoc) {
  if (!eventDoc || !draftId || eventDoc.draftEditsFrom !== draftId) return false;
  return !(draftDoc && stamp(draftDoc) > stamp(eventDoc));
}

// Returns { override, draftId } for a page id. draftId is the bound draft
// whose edits were considered ("" when none). Pass options.draftId when the
// caller already knows the bound draft, to skip the site event scan.
export async function resolvePageOverride(kv, id, options = {}) {
  const eventDoc = await readOverrideDoc(kv, id);
  if (!isOtraGuideId(id)) return { override: eventDoc, draftId: "" };
  let draftId = options.draftId ? String(options.draftId) : "";
  if (!draftId && options.draftId === undefined) {
    const project = await findProjectByOtraGuideId(kv, id);
    draftId = project ? String(project.id || "") : "";
  }
  if (!draftId) return { override: eventDoc, draftId: "" };
  const draftDoc = await readOverrideDoc(kv, draftId);
  if (!draftDoc) return { override: eventDoc, draftId };
  if (coversDraft(eventDoc, draftId, draftDoc)) return { override: eventDoc, draftId };
  return { override: mergeOverrideDocs(draftDoc, eventDoc), draftId };
}
