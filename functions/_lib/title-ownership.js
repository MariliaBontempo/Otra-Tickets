// Model B title rules.
// - guideTitleSsotId: where a rename is written and which Guide title is shown
//   when Guide has one. Owned AND borrowed/checkout-bound pages.
// - ownedGuideTitleId: OT-created events only (not borrowed, not checkout-only).
//   Only these drop their local title copy and follow Guide privacy (404 /
//   card omitted). Borrowed pages keep a local mirror and their old visibility,
//   so a private or unreachable Guide never turns them into a 404.
// Keep-selling pages (legacy list or the admin switch) stay fully local.
import { HIDDEN_DETAIL_EXCEPTIONS } from "./keep-selling-exceptions.js";
export const TITLE_FIELD = "text:#evTitle";

function numericGuideId(value) {
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) ? id : "";
}

// Guide title SSOT id for an OT project. Owned pages use otraGuideId.
// Borrowed pages (usesExistingOtraGuideEvent) use the same id — the flag
// no longer blocks SSOT. If otraGuideId is empty, a numeric checkoutEventId
// is used (Daniel draft has checkoutEventId "8333"). Keep-selling stays local.
export function guideTitleSsotId(project) {
  if (!project || typeof project !== "object") return "";
  const id = numericGuideId(project.otraGuideId) || numericGuideId(project.checkoutEventId);
  if (!id) return "";
  if (keepsSellingTitleLocally(project, id)) return "";
  return id;
}

export function ownedGuideTitleId(project) {
  if (!project || typeof project !== "object") return "";
  const id = numericGuideId(project.otraGuideId);
  if (!id || project.usesExistingOtraGuideEvent) return "";
  if (keepsSellingTitleLocally(project, id)) return "";
  return id;
}

export function keepsSellingTitleLocally(project, guideId = project?.otraGuideId) {
  if (!project || typeof project !== "object") return false;
  if (project.keepSellingWhileGuidePrivate === true) return true;
  return !!project.id && HIDDEN_DETAIL_EXCEPTIONS[String(guideId)] === String(project.id);
}

export function withoutTitleOverride(doc, { keepStyleMatching, keepAnyStyle } = {}) {
  if (!doc || typeof doc !== "object") return doc;
  const { title, displayTitle, homepageOverrideTitle, guideTitle, guideTitleUnavailable, warning, ...next } = doc;
  if (doc.fields) {
    next.fields = { ...doc.fields };
    for (const key of Object.keys(next.fields)) {
      if (!isTitleField(key)) continue;
      const field = next.fields[key];
      const style = keepStyleMatching
        ? styleOnlyTitleField(field, keepStyleMatching)
        : (keepAnyStyle && field && field.type === "text" && typeof field.html === "string" && field.html
          ? { type: "text", value: String(field.value || "").trim(), html: field.html }
          : null);
      if (style) next.fields[key] = style;
      else delete next.fields[key];
    }
  }
  return next;
}

// Storage projection only. No fallback title or Guide response is persisted.
export function withoutLocalProjectTitle(project) {
  if (!ownedGuideTitleId(project)) return project;
  const next = withoutTitleOverride(project);
  for (const key of ["claudeDesign", "design"]) {
    if (next[key] && typeof next[key] === "object") next[key] = withoutTitleOverride(next[key]);
  }
  return next;
}

// Older editor versions used selectors such as "text:main > #evTitle".
// Style lives on the same text:#evTitle field as `.html`, not a durable plain SSOT.
export function isTitleField(key) {
  return typeof key === "string" && key.startsWith("text:") && /#evTitle\b/.test(key);
}

// Keep formatting only when stripped plain text equals the Guide title.
export function styleOnlyTitleField(field, guidePlain) {
  if (!field || field.type !== "text" || typeof field.html !== "string" || !field.html) return null;
  if (typeof guidePlain !== "string" || !guidePlain.trim()) return null;
  const plain = String(field.value || "").trim();
  if (plain !== guidePlain.trim()) return null;
  return { type: "text", value: plain, html: field.html };
}

export function overrideHasDurableTitleCopy(doc) {
  if (!doc || typeof doc !== "object") return false;
  if (typeof doc.title === "string" && doc.title.trim()) return true;
  if (typeof doc.displayTitle === "string" && doc.displayTitle.trim()) return true;
  if (typeof doc.homepageOverrideTitle === "string" && doc.homepageOverrideTitle.trim()) return true;
  const fields = doc.fields && typeof doc.fields === "object" ? doc.fields : {};
  for (const [key, field] of Object.entries(fields)) {
    if (!isTitleField(key) || !field || field.type !== "text") continue;
    // A style-only layer with html is allowed; a plain value without matching
    // Guide-checked html is a durable local title copy.
    if (typeof field.value === "string" && field.value.trim() && !field.html) return true;
  }
  return false;
}
