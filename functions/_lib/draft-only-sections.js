// Sections that may be hidden only on an unpublished draft.
//
// TJ asked to take Before You Go off the new Strange Bird / Francis Sling
// drafts. Marília's rule: Before You Go is never hidden on a published or
// live page. So the hide is a normal remove field on the draft's own edits
// (event:<draftId>), but every reader drops it unless the page being shown is
// a draft id whose site event is still an unpublished draft. A live page
// (Otra Guide id, or a published draft) merges the draft edits and still
// shows Before You Go.

export const DRAFT_ONLY_SECTION_ID = "evInfoSection";
export const DRAFT_ONLY_REMOVE_KEYS = Object.freeze([
  "remove:#evInfoSection",
  "remove:main > #evInfoSection",
]);

export function isDraftOnlyRemoveKey(key) {
  return DRAFT_ONLY_REMOVE_KEYS.includes(String(key || "").trim());
}

export function isUnpublishedDraft(project) {
  return Boolean(
    project &&
      typeof project === "object" &&
      project.status === "draft" &&
      !project.publishedAt &&
      !project.archivedAt
  );
}

// True only for a draft-* id whose site event is an unpublished draft.
export async function allowsDraftOnlyRemovals(kv, id) {
  if (!kv || !/^draft-(?!prod-)[a-zA-Z0-9-]+$/.test(String(id || ""))) return false;
  let project = null;
  try {
    project = await kv.get(`site-event:${id}`, "json");
    if (typeof project === "string") project = JSON.parse(project);
  } catch {
    project = null;
  }
  return isUnpublishedDraft(project);
}

// Returns a copy of fields without the draft-only removals.
export function withoutDraftOnlyRemovals(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fields;
  const out = {};
  for (const [key, field] of Object.entries(fields)) {
    if (isDraftOnlyRemoveKey(key)) continue;
    out[key] = field;
  }
  return out;
}
