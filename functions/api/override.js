// Cloudflare Pages Function: GET /api/override?id=<eventId>
//
// Public read-only override endpoint for hand-built pages that do not render
// through /api/event. Admin writes stay behind /admin/api/overrides.

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(id)) return json({ error: "invalid id" }, 400);

  if (!context.env.OVERRIDES) return json({ override: null });

  try {
    const override = await context.env.OVERRIDES.get(`event:${id}`, "json");
    if (!override || typeof override !== "object") return json({ override: null });
    return json({
      override: {
        description: typeof override.description === "string" ? override.description : "",
        image: typeof override.image === "string" ? override.image : "",
        fields: normalizeFields(override.fields),
        updatedAt: typeof override.updatedAt === "string" ? override.updatedAt : null,
      },
    });
  } catch {
    return json({ error: "could not load override" }, 500);
  }
}

function normalizeFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const fields = {};
  for (const [key, field] of Object.entries(raw)) {
    if (typeof key !== "string" || !field || typeof field !== "object") continue;
    if (field.type !== "text" && field.type !== "image") continue;
    fields[key] = {
      type: field.type,
      value: typeof field.value === "string" ? field.value : "",
    };
  }
  return fields;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
