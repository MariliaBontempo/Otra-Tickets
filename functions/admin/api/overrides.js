// Cloudflare Pages Function: GET/PUT /admin/api/overrides?id=<eventId>
//
// Staff-only editor API. Text overrides live in Cloudflare KV under event:<id>.

const API = "https://otraguide.com/api";

export async function onRequestGet(context) {
  const auth = await requireStaff(context.request);
  if (!auth.ok) return auth.response;

  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  if (!context.env.OVERRIDES) return json({ error: "OVERRIDES binding is missing" }, 500);

  const override = await context.env.OVERRIDES.get(`event:${id}`, "json");
  return json({ override: override || null });
}

export async function onRequestPut(context) {
  const auth = await requireStaff(context.request);
  if (!auth.ok) return auth.response;

  const id = getId(context.request);
  if (!id) return json({ error: "invalid id" }, 400);
  if (!context.env.OVERRIDES) return json({ error: "OVERRIDES binding is missing" }, 500);

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
  await context.env.OVERRIDES.put(`event:${id}`, JSON.stringify(override));
  return json({ override });
}

function normalizeFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const fields = {};
  for (const [key, field] of Object.entries(raw)) {
    if (typeof key !== "string" || key.length > 500) continue;
    if (!field || typeof field !== "object") continue;
    const type = field.type === "image" ? "image" : field.type === "text" ? "text" : "";
    if (!type) continue;
    const value = typeof field.value === "string" ? field.value.trim() : "";
    fields[key] = { type, value };
  }
  return fields;
}

function getId(request) {
  const id = (new URL(request.url).searchParams.get("id") || "").trim();
  return /^\d+$/.test(id) ? id : "";
}

function isAllowedImageUrl(value) {
  try {
    const url = new URL(value, "https://otratickets.com");
    return url.pathname.startsWith("/override-images/") || /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
}

async function requireStaff(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, response: json({ error: "missing token" }, 401) };
  const ok = await checkStaff(m[1]);
  return ok ? { ok: true } : { ok: false, response: json({ error: "forbidden" }, 403) };
}

async function checkStaff(accessToken) {
  try {
    const resp = await fetch(`${API}/users/user-role/`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.is_staff_or_admin;
  } catch {
    return false;
  }
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
