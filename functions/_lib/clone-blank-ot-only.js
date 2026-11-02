// Studio clone with blankOtOnlyFields: true.
//
// Otra Guide Studio creates the Guide event (title, description, image,
// dates, location, team, tickets) and then asks Otra Tickets to clone a
// template page bound to it through existingEventId. The goal: fields that
// Studio already mapped onto the Guide event stay filled from that event
// after bind (project title/description/image, design displayTitle,
// description and image, dates, location, team, region, rates, quantities,
// ticket type ids). Only OT only fields with no Studio mapping start blank:
// subtitle, headings, story, perks and sponsor content, practical info /
// Before You Go, video, photo band, hero meta, gallery and assets. The
// template shell survives: layout choices, rate rows and accent color.

// Kept from the source design: layout only, never event content.
export const SHELL_DESIGN_KEYS = ["perkLayout", "sponsorLayout"];

// Kept from the source page override: style only, never content.
export const SHELL_OVERRIDE_KEYS = ["accentColor"];

// Keys cleared on the clone (listed for docs and checks). displayTitle,
// description and image are refilled from the Guide event after an
// existingEventId bind (see blankOtOnlyMappedDesignFromGuide).
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

// Studio mapped design fields, refilled from the bound Guide event.
export const GUIDE_MAPPED_DESIGN_KEYS = ["displayTitle", "description", "image"];

// After an existingEventId bind, copy the Guide mapped project fields into
// the design so the admin editor shows them. The bound project already holds
// the Guide title, description and image; an empty Guide value stays blank
// (never a template fallback, since the clone design was blanked first).
export function blankOtOnlyMappedDesignFromGuide(project) {
  const p = project && typeof project === "object" ? project : {};
  const text = (value) => (typeof value === "string" ? value : "");
  return {
    ...p,
    claudeDesign: {
      ...(p.claudeDesign || {}),
      displayTitle: text(p.title),
      description: text(p.description),
      image: text(p.image),
    },
  };
}
