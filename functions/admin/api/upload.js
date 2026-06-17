// Cloudflare Pages Function: POST /admin/api/upload
//
// Staff-only image upload. Images are stored in R2 and served from
// /override-images/<key>.

const API = "https://otraguide.com/api";
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export async function onRequestPost(context) {
  const auth = await requireStaff(context.request);
  if (!auth.ok) return auth.response;
  if (!context.env.OVERRIDE_IMAGES) return json({ error: "OVERRIDE_IMAGES binding is missing" }, 500);

  let form;
  try {
    form = await context.request.formData();
  } catch {
    return json({ error: "invalid form data" }, 400);
  }

  const id = String(form.get("id") || "").trim();
  const file = form.get("file");
  if (!/^\d+$/.test(id)) return json({ error: "invalid id" }, 400);
  if (!(file instanceof File)) return json({ error: "file is required" }, 400);
  if (!TYPES[file.type]) return json({ error: "unsupported image type" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "image must be 8MB or smaller" }, 400);

  const key = `${id}/${crypto.randomUUID()}.${TYPES[file.type]}`;
  await context.env.OVERRIDE_IMAGES.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      originalName: file.name || "upload",
      eventId: id,
    },
  });

  return json({ url: `/override-images/${key}`, key });
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
