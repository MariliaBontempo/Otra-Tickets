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

// Admin clone labels are never pretty-URL tokens.
export function eventSlugFromTitle(title) {
  return eventSlug(
    String(title || "")
      .replace(/\(\s*clone\s*\)/gi, " ")
      .replace(/\bclone\b/gi, " ")
  );
}

// Persist / read the first-published pretty slug. Prefer an already-frozen
// value; otherwise mint from the seed / curated title (never displayTitle).
export function mintFrozenSlug(project) {
  if (!project || typeof project !== "object") return "";
  const existing = typeof project.frozenSlug === "string" ? eventSlug(project.frozenSlug) : "";
  if (existing) return existing;
  const title = typeof project.title === "string" ? project.title.trim() : "";
  return eventSlugFromTitle(title);
}
