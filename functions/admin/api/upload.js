// Cloudflare Pages Function: POST /admin/api/upload
//
// Staff-only media upload. Prefer R2 when available; otherwise store small
// images in the OVERRIDES KV namespace and serve them from /override-images/.
// Videos are R2-only: they are far too large for the KV fallback.

import { staffSession, json } from "./_auth.js";
import { actorFromSession, appendAudit } from "./_audit.js";

const MAX_BYTES = 8 * 1024 * 1024;
const KV_MAX_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const KV_IMAGE_PREFIX = "uploaded-image:";
const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};
const VIDEO_TYPES = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export async function onRequestPost(context) {
  const session = await staffSession(context.request, context.env);
  if (!session) return json({ error: "unauthorized" }, 401);

  let form;
  try {
    form = await context.request.formData();
  } catch {
    return json({ error: "invalid form data" }, 400);
  }

  const queryId = new URL(context.request.url).searchParams.get("id") || "";
  const id = String(form.get("id") || queryId).trim();
  const file = form.get("file");
  if (!/^(?:\d+|draft-[a-zA-Z0-9-]+)$/.test(id)) return json({ error: "invalid id" }, 400);
  if (!(file instanceof File)) return json({ error: "file is required" }, 400);
  const isVideo = !!VIDEO_TYPES[file.type];
  if (!TYPES[file.type] && !isVideo) return json({ error: "unsupported media type" }, 400);
  if (isVideo && file.size > MAX_VIDEO_BYTES) return json({ error: "video must be 100MB or smaller" }, 400);
  if (!isVideo && file.size > MAX_BYTES) return json({ error: "image must be 8MB or smaller" }, 400);

  const key = `${id}/${crypto.randomUUID()}.${isVideo ? VIDEO_TYPES[file.type] : TYPES[file.type]}`;
  const bucket = context.env.OVERRIDE_IMAGES;
  if (isVideo && !bucket) return json({ error: "video upload requires R2 storage" }, 503);
  const kv = context.env.OVERRIDES;
  if (bucket) {
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
  } else {
    if (!kv) return json({ error: "image store not configured" }, 503);
    if (file.size > KV_MAX_BYTES) return json({ error: "image must be 2MB or smaller" }, 400);
    const dataUrl = await fileToDataUrl(file);
    await kv.put(
      `${KV_IMAGE_PREFIX}${key}`,
      JSON.stringify({
        contentType: file.type,
        dataUrl,
        originalName: file.name || "upload",
        eventId: id,
        uploadedAt: new Date().toISOString(),
      })
    );
  }

  if (kv) {
    await appendAudit(kv, {
      actor: actorFromSession(session.token, session.role),
      action: "upload",
      pageId: id,
      file: {
        name: file.name || "upload",
        key,
        contentType: file.type,
      },
    });
  }

  return json({ url: `/override-images/${key}`, key });
}

async function fileToDataUrl(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
}
