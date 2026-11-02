// Studio clone with blankOtOnlyFields: true.
//
// Otra Guide Studio creates the Guide event (title, dates, tickets) and then
// asks Otra Tickets to clone a template page. The page content that only
// lives on Otra Tickets (story, perks, sponsors, practical info / Before You
// Go, video, photo band, hero meta) must start blank so the Studio checklist
// of blanks is real. Only the template shell survives: layout choices and
// the rate rows that seed ticket types when no existing event is bound.

// Kept from the source design: layout only, never event content.
export const SHELL_DESIGN_KEYS = ["perkLayout", "sponsorLayout"];

// Kept from the source page override: style only, never content.
export const SHELL_OVERRIDE_KEYS = ["accentColor"];

// OT only content keys cleared on the clone (listed for docs and checks).
export const BLANKED_DESIGN_KEYS = [
  "title", "displayTitle", "subtitle", "eyebrow", "tag", "meta",
  "description", "image", "heroKey", "heroName",
  "storyImage", "pullQuote", "storyEyebrow",
  "videoImage",
  "bandImage", "bandEyebrow", "bandTitle", "bandText", "appreciates",
  "sponsorTitle", "sponsorText", "sponsorGroups",
  "photoBandImage",
  "practicalTitle", "practicalInfo",
  "galleryImages", "assets",
];

export function wantsBlankOtOnlyFields(body) {
  return !!body && body.blankOtOnlyFields === true;
}

// Fresh design for the clone: no content, layout kept, rates kept as the
// ticket type seed (replaced from the Guide event when existingEventId binds).
export function blankOtOnlyCloneDesign(sourceDesign) {
  const source = sourceDesign && typeof sourceDesign === "object" ? sourceDesign : {};
  const design = {};
  for (const key of SHELL_DESIGN_KEYS) {
    if (key in source) design[key] = source[key];
  }
  design.rates = Array.isArray(source.rates) ? source.rates.map((rate) => ({ ...rate })) : [];
  if (typeof source.ratesTitle === "string") design.ratesTitle = source.ratesTitle;
  design.displayTitle = "";
  design.subtitle = "";
  design.eyebrow = "";
  design.tag = "";
  design.meta = [];
  design.description = "";
  design.image = "";
  design.storyImage = "";
  design.pullQuote = "";
  design.storyEyebrow = "";
  design.videoImage = "";
  design.bandImage = "";
  design.bandEyebrow = "";
  design.bandTitle = "";
  design.bandText = "";
  design.appreciates = [];
  design.sponsorTitle = "";
  design.sponsorText = "";
  design.sponsorGroups = [];
  design.photoBandImage = "";
  design.practicalTitle = "";
  design.practicalInfo = [];
  design.galleryImages = [];
  design.assets = [];
  return design;
}

// Page override for the clone: style keys only, or null when nothing to keep.
// Field edits (text, images, video, removals, hides) are never copied.
export function blankOtOnlyCloneOverride(sourceOverride, cloneId) {
  if (!sourceOverride || typeof sourceOverride !== "object" || Array.isArray(sourceOverride)) return null;
  const out = {};
  for (const key of SHELL_OVERRIDE_KEYS) {
    if (typeof sourceOverride[key] === "string" && sourceOverride[key].trim()) out[key] = sourceOverride[key];
  }
  if (!Object.keys(out).length) return null;
  return { ...out, id: cloneId };
}

// Project level content fields cleared alongside the design.
export function blankOtOnlyCloneProjectFields(clone) {
  return {
    ...clone,
    description: "",
    image: "",
    claudeDesign: blankOtOnlyCloneDesign(clone && clone.claudeDesign),
    blankOtOnlyFields: true,
  };
}
