// Cloudflare Pages Function: POST /admin/api/upload
//
// Staff-only image upload. Images are stored in R2 and served from
// /override-images/<key>.

import { requireStaff, json } from "./_auth.js";

const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export async function onRequestPost(context) {
  if (!(await requireStaff(context.request))) return json({ error: "unauthorized" }, 401);

  const bucket = context.env.OVERRIDE_IMAGES;
  if (!bucket) return json({ error: "image store not configured" }, 503);

  let form;
  try {
    form = await context.request.formData();
  } catch {
    return json({ error: "invalid form data" }, 400);
  }

  const queryId = new URL(context.request.url).searchParams.get("id") || "";
  const id = String(form.get("id") || queryId).trim();
  const file = form.get("file");
  if (!/^\d+$/.test(id)) return json({ error: "invalid id" }, 400);
  if (!(file instanceof File)) return json({ error: "file is required" }, 400);
  if (!TYPES[file.type]) return json({ error: "unsupported image type" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "image must be 8MB or smaller" }, 400);

  const key = `${id}/${crypto.randomUUID()}.${TYPES[file.type]}`;
  await bucket.put(key, file.stream(), {
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
