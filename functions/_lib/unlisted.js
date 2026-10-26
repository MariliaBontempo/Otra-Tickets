// Unlisted ("link only") site pages.
//
// An unlisted page is a published Otra Tickets page that never shows on the
// homepage, in search, in the sitemap or in llms.txt, but still opens (and
// sells) at its own short pretty URL, e.g. /strange-bird-gala-secret.
// It is privacy by obscurity, not access control: anyone with the link can
// open it. Admin-only stays the switch for staff-only pages.

import { eventSlug, eventSlugFromTitle, liveSlugBase, persistedFrozenSlug } from "./event-slug.js";
import { SLUG_ALIASES } from "./slug-aliases.js";

// Short and readable on purpose: the link is shared by hand.
export const UNLISTED_SLUG_MAX = 60;

// Paths the site already uses. An unlisted link must never shadow them.
const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "assets",
  "clearboat",
  "deploy",
  "docs",
  "event",
  "events",
  "favicon",
  "fonts",
  "functions",
  "index",
  "llms",
  "override-images",
  "override-media",
  "photos",
  "rnb",
  "robots",
  "server",
  "sitemap",
  "uploads",
]);

export function isUnlistedProject(project) {
  return !!project && typeof project === "object" && project.unlisted === true;
}

// The one rule for "this unlisted page opens at /<frozenSlug>".
export function isServableUnlisted(project) {
  return (
    isUnlistedProject(project) &&
    project.status === "published" &&
    !project.archivedAt &&
    project.adminOnly !== true &&
    !!persistedFrozenSlug(project)
  );
}

// "Strange Bird Gala (secret)!" -> "strange-bird-gala-secret". Cut on a word
// boundary so a long title never becomes a long link.
export function cleanUnlistedSlug(value) {
  let slug = eventSlug(value);
  if (slug.length > UNLISTED_SLUG_MAX) {
    slug = slug.slice(0, UNLISTED_SLUG_MAX);
    const cut = slug.lastIndexOf("-");
    if (cut > 20) slug = slug.slice(0, cut);
    slug = slug.replace(/-+$/g, "");
  }
  return slug;
}

export function unlistedSlugProblem(slug) {
  if (!slug) return "Use letters, numbers and dashes, for example strange-bird-gala-secret.";
  if (/^\d+$/.test(slug)) return "The link needs at least one letter.";
  if (RESERVED_SLUGS.has(slug) || SLUG_ALIASES.has(slug)) return `/${slug} is already used by the site. Pick another link.`;
  return "";
}

// Default link for a page: the slug it already has, else its title.
export function defaultUnlistedSlug(project) {
  const published = project && (project.status === "published" || project.publishedAt);
  const base = published
    ? liveSlugBase(project)
    : persistedFrozenSlug(project) || eventSlugFromTitle(project && project.title);
  return cleanUnlistedSlug(base);
}

// Picks the unlisted link. `taken` maps slug -> title of the page using it.
// An explicit link that is taken is refused with a clear message; a default
// link that is taken gets a plain counter (-2, -3), never an id or a hash.
export function pickUnlistedSlug({ requested = "", fallback = "", taken = new Map() }) {
  const explicit = String(requested || "").trim();
  const base = cleanUnlistedSlug(explicit || fallback);
  const problem = unlistedSlugProblem(base);
  if (problem) return { error: problem, status: 400 };
  if (!taken.has(base)) return { slug: base };
  if (explicit) {
    const owner = taken.get(base);
    return {
      error: `/${base} is already used${owner ? ` by "${owner}"` : ""}. Pick another link.`,
      status: 409,
    };
  }
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return { slug: candidate };
  }
  return { error: "Could not find a free link. Pick one with Edit link.", status: 409 };
}
