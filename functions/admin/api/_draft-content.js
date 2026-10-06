// Plain content only. Commercial configuration remains outside this editor.
export function contentSnapshot(project) {
  return { description: project.description || "", claudeDesign: project.claudeDesign || null };
}

export function validateContentPatch(patch, project) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("content is required");
  const textLimits = { description: 20000, bandEyebrow: 200, bandTitle: 500, sponsorTitle: 500, sponsorText: 10000 };
  const allowed = new Set([...Object.keys(textLimits), "appreciates"]);
  const fields = Object.keys(patch);
  if (!fields.length || fields.some(key => !allowed.has(key))) throw new Error("unsupported content field");
  // The per-field limits allow roughly 130k characters across 12 perks.
  // Leave room for image URLs and JSON syntax without rejecting valid input.
  if (JSON.stringify(patch).length > 192000) throw new Error("content is too long");
  const next = {};
  for (const [key, limit] of Object.entries(textLimits)) {
    if (!(key in patch)) continue;
    if (typeof patch[key] !== "string" || patch[key].length > limit) throw new Error(`invalid ${key}`);
    next[key] = patch[key].trim();
  }
  if ("appreciates" in patch) {
    if (!Array.isArray(patch.appreciates) || patch.appreciates.length > 12) throw new Error("invalid appreciation items");
    const images = new Set(project.claudeDesign?.galleryImages || []);
    next.appreciates = patch.appreciates.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["name", "description", "image"].includes(key))) throw new Error("invalid appreciation item");
      if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 200 || typeof item.description !== "string" || item.description.length > 8000) throw new Error("invalid appreciation text");
      const image = item.image === undefined ? "" : item.image;
      if (typeof image !== "string" || (image && (!image.startsWith(`/override-images/${project.id}/claude-design/`) || !images.has(image)))) throw new Error("image must belong to this draft");
      return { name: item.name.trim(), description: item.description.trim(), image };
    });
  }
  return next;
}
