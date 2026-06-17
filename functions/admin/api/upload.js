// Cloudflare Pages Function: POST /admin/api/upload?id=<eventId>
//
// Accept an image file from the editor and store it in the R2 bucket bound as
// OVERRIDE_IMAGES. Returns a same-origin URL that /override-media serves.
// Gated on a valid Otra Guide staff/admin token. The returned URL is what the
// editor saves into the event's override.

import { requireStaff, json } from "./_auth.js";

export async function onRequestPost(context) {
  const id = (new URL(context.request.url).searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(id)) return json({ error: "invalid id" }, 400);
  if (!(await requireStaff(context.request))) return json({ error: "unauthorized" }, 401);

  const bucket = context.env.OVERRIDE_IMAGES;
  if (!bucket) return json({ error: "image store not configured" }, 503);

  let form;
  try {
    form = await context.request.formData();
  } catch {
    return json({ error: "invalid upload" }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "no file provided" }, 400);

  const type = file.type || "";
  if (!/^image\//.test(type)) return json({ error: "file must be an image" }, 400);
  if (file.size > 12 * 1024 * 1024) return json({ error: "image is too large (max 12MB)" }, 413);

  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  // A fresh key each upload busts caches and avoids overwrites.
  const key = `event/${id}/${Date.now()}.${ext}`;

  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
  });

  return json({ url: `/override-media/${key}` });
}
