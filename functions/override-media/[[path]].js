// Cloudflare Pages Function: GET /override-media/<key>
//
// Public, cached serving of the images staff upload (stored in the R2 bucket
// bound as OVERRIDE_IMAGES). The editor's upload returns URLs under this path,
// which the public event pages then reference.

const KV_IMAGE_PREFIX = "uploaded-image:";

export async function onRequestGet(context) {
  const parts = context.params.path; // catch-all segments after /override-media/
  const key = Array.isArray(parts) ? parts.join("/") : String(parts || "");
  if (!key) return new Response("not found", { status: 404 });

  const bucket = context.env.OVERRIDE_IMAGES;
  if (bucket) {
    const object = await bucket.get(key);
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      if (!headers.has("cache-control")) {
        headers.set("cache-control", "public, max-age=31536000, immutable");
      }
      return new Response(object.body, { headers });
    }
  }

  const kv = context.env.OVERRIDES;
  if (!kv) return new Response("not found", { status: 404 });
  const image = await kv.get(`${KV_IMAGE_PREFIX}${key}`, "json");
  if (!image || !image.dataUrl) return new Response("not found", { status: 404 });

  const match = String(image.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return new Response("not found", { status: 404 });
  const bytes = base64ToBytes(match[2]);
  return new Response(bytes, {
    headers: {
      "content-type": image.contentType || match[1] || "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
