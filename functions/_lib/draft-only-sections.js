// Sections that may be hidden only on an unpublished draft.
//
// TJ asked to take Before You Go off the new Strange Bird / Francis Sling
// drafts. Marília's rule: Before You Go is never hidden on a published or
// live page. So the hide is a normal remove field on the draft's own edits
// (event:<draftId>), but every reader drops it unless the page being shown is
// a draft id whose site event is still an unpublished draft. A live page
// (Otra Guide id, or a published draft) merges the draft edits and still
// shows Before You Go.
//
// Separate from this hide: event.html never opens Before You Go when its
// only cell would be the automatic "Tickets — From …" price (no authored
// cells, no dates). That is a page with nothing to say there, not a hidden
// section, and a staff edit to any of its cells opens it again.

export const DRAFT_ONLY_SECTION_ID = "evInfoSection";
export const DRAFT_ONLY_REMOVE_KEYS = Object.freeze([
  "remove:#evInfoSection",
  "remove:main > #evInfoSection",
]);

// Any remove field that targets Before You Go or its info grid by id, with
// or without a "main >" or "section" prefix. Selectors that reach it by
// position are caught on the page by site-overrides.js hidesBeforeYouGo.
const DRAFT_ONLY_REMOVE_RE = /^remove:\s*(?:main\s*>\s*)?(?:section)?#evInfo(?:Section|Grid)\s*$/;

export function isDraftOnlyRemoveKey(key) {
  const value = String(key || "").trim();
  return DRAFT_ONLY_REMOVE_KEYS.includes(value) || DRAFT_ONLY_REMOVE_RE.test(value);
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
