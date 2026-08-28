export function eventSlug(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

// Admin clone labels are never pretty-URL tokens. Mint time only
// (first persist of frozenSlug in projects.js). Never the implicit
// legacy fallback for published rows that lack the field.
export function eventSlugFromTitle(title) {
  return eventSlug(
    String(title || "")
      .replace(/\(\s*clone\s*\)/gi, " ")
      .replace(/\bclone\b/gi, " ")
  );
}

// Pre-4fb799d projectCardTitle. Implicit slug source for published
// rows that never persisted frozenSlug. Card titles no longer use
// this: shared displayTitle must stay off cards.
export function legacyCuratedTitle(project) {
  if (!project || typeof project !== "object") return "";
  const title = typeof project.title === "string" ? project.title.trim() : "";
  const design = project.claudeDesign && typeof project.claudeDesign === "object" ? project.claudeDesign : {};
  const displayTitle = typeof design.displayTitle === "string" ? design.displayTitle.trim() : "";
  const subtitle = typeof design.subtitle === "string" ? design.subtitle.trim() : "";

  if (displayTitle && (!title || (subtitle && title === `${displayTitle} - ${subtitle}`))) return displayTitle;
  return title || displayTitle || "Claude Design Event";
}

export function persistedFrozenSlug(project) {
  if (!project || typeof project !== "object") return "";
  return typeof project.frozenSlug === "string" ? project.frozenSlug.trim() : "";
}

// What the feed serves today for a published row: the persisted
// frozenSlug byte for byte, else eventSlug of the pre-4fb799d
// curated / seed title. Used when a rename stamps the field on
// an older published row, and as the implicit legacy feed base.
export function liveSlugBase(project) {
  const existing = persistedFrozenSlug(project);
  if (existing) return existing;
  return eventSlug(legacyCuratedTitle(project));
}

// Persist / read the first-published pretty slug. Prefer an already-frozen
// value; otherwise mint from the current title and strip clone. Callers
// that need the live pre-deploy base (legacy rename stamp, feed fallback)
// must use liveSlugBase instead.
export function mintFrozenSlug(project) {
  if (!project || typeof project !== "object") return "";
  const existing = persistedFrozenSlug(project);
  if (existing) return eventSlug(existing);
  const title = typeof project.title === "string" ? project.title.trim() : "";
  return eventSlugFromTitle(title);
}
