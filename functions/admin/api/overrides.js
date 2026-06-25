// Cloudflare Pages Function: GET/PUT /admin/api/overrides?id=<eventId>
//
// Staff-only editor API. Overrides live in Cloudflare KV and can target the
// main event description/image plus arbitrary page fields.

import { requireStaff, json } from "./_auth.js";

const KEY = (id) => `event:${id}`;
const LEGACY_KEY = (id) => `override:${id}`;

export async function onRequestGet(context) {
  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  if (!(await requireStaff(context.request, context.env))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  const override = await readOverride(kv, id);
  return json({ override });
}

export async function onRequestPut(context) {
  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  if (!(await requireStaff(context.request, context.env))) return json({ error: "unauthorized" }, 401);

  const kv = context.env.OVERRIDES;
  if (!kv) return json({ error: "overrides store not configured" }, 503);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  const image = typeof body.image === "string" ? body.image.trim() : "";
  const fields = normalizeFields(body.fields);
  if (description.length > 20000) return json({ error: "description is too long" }, 400);
  if (image && !isAllowedImageUrl(image)) return json({ error: "invalid image url" }, 400);
  for (const field of Object.values(fields)) {
    if (field.type === "text" && field.value.length > 20000) {
      return json({ error: "text field is too long" }, 400);
    }
    if (field.type === "image" && field.value && !isAllowedImageUrl(field.value)) {
      return json({ error: "invalid image url" }, 400);
    }
  }

  const override = {
    id,
    description,
    image,
    fields,
    updatedAt: new Date().toISOString(),
  };
  await kv.put(KEY(id), JSON.stringify(override));
  return json({ override });
}

async function readOverride(kv, id) {
  const raw = (await kv.get(KEY(id))) || (await kv.get(LEGACY_KEY(id)));
  return raw ? normalizeOverride(JSON.parse(raw), id) : null;
}

function normalizeOverride(raw, id) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id,
    description: typeof raw.description === "string" ? raw.description : "",
    image: typeof raw.image === "string" ? raw.image : "",
    fields: normalizeFields(raw.fields),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

function normalizeFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const fields = {};
  for (const [key, field] of Object.entries(raw)) {
    if (typeof key !== "string" || key.length > 500) continue;
    if (!field || typeof field !== "object") continue;
    const type = field.type === "image" ? "image" : field.type === "text" ? "text" : field.type === "remove" ? "remove" : "";
    if (!type) continue;
    const value = typeof field.value === "string" ? field.value.trim() : "";
    fields[key] = { type, value };
  }
  return fields;
}

function getId(request) {
  const id = (new URL(request.url).searchParams.get("id") || "").trim();
  return /^(?:\d+|draft-[a-zA-Z0-9-]+)$/.test(id) ? id : "";
}

function isAllowedImageUrl(value) {
  try {
    const url = new URL(value, "https://otratickets.com");
    return (
      url.pathname.startsWith("/override-images/") ||
      url.pathname.startsWith("/override-media/") ||
      url.pathname.startsWith("/uploads/") ||
      /^https?:$/.test(url.protocol)
    );
  } catch {
    return false;
  }
}
