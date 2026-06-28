// Cloudflare Pages Function: GET /override-images/<key>

const KV_IMAGE_PREFIX = "uploaded-image:";

export async function onRequestGet(context) {
  const param = context.params.path;
  const key = Array.isArray(param) ? param.join("/") : String(param || "");
  if (!key || key.includes("..")) return new Response("Not found", { status: 404 });

  const bucket = context.env.OVERRIDE_IMAGES;
  if (bucket) {
    const object = await bucket.get(key);
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", headers.get("cache-control") || "public, max-age=31536000, immutable");
      return new Response(object.body, { headers });
    }
  }

  const kv = context.env.OVERRIDES;
  if (!kv) return new Response("Not found", { status: 404 });
  if (typeof kv.getWithMetadata === "function") {
    const stored = await kv.getWithMetadata(`${KV_IMAGE_PREFIX}${key}`, "arrayBuffer");
    if (stored && stored.value && stored.metadata && stored.metadata.storage === "binary") {
      return new Response(stored.value, {
        headers: {
          "content-type": stored.metadata.contentType || "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }
  }
  const image = await kv.get(`${KV_IMAGE_PREFIX}${key}`, "json");
  if (!image || !image.dataUrl) return new Response("Not found", { status: 404 });

  const match = String(image.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return new Response("Not found", { status: 404 });
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
