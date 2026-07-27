// Cloudflare Pages Function: GET /override-images/<key>

const KV_IMAGE_PREFIX = "uploaded-image:";

export async function onRequestGet(context) {
  const param = context.params.path;
  const key = Array.isArray(param) ? param.join("/") : String(param || "");
  if (!key || key.includes("..")) return new Response("Not found", { status: 404 });

  const bucket = context.env.OVERRIDE_IMAGES;
  if (bucket) {
    // Video playback depends on Range support: browsers request
    // "Range: bytes=0-" and stall waiting for a 206 that never came.
    // R2 serves ranges natively.
    const range = parseRange(context.request.headers.get("range"));
    const object = await bucket.get(key, range ? { range } : undefined);
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("accept-ranges", "bytes");
      headers.set("cache-control", headers.get("cache-control") || "public, max-age=31536000, immutable");
      if (range && object.range) {
        const offset = object.range.offset !== undefined ? object.range.offset : object.size - object.range.suffix;
        const length = object.range.length !== undefined ? object.range.length : object.size - offset;
        headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
        headers.set("content-length", String(length));
        return new Response(object.body, { status: 206, headers });
      }
      return new Response(object.body, { headers });
    }
  }

  const kv = context.env.OVERRIDES;
  if (!kv) return devFallbackOr404(context, key);
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
  if (!image || !image.dataUrl) return devFallbackOr404(context, key);

  const match = String(image.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return devFallbackOr404(context, key);
  const bytes = base64ToBytes(match[2]);
  return new Response(bytes, {
    headers: {
      "content-type": image.contentType || match[1] || "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}


// "bytes=a-b" | "bytes=a-" | "bytes=-n" -> R2 range option, or null.
function parseRange(header) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") return { suffix: Number(match[2]) };
  const offset = Number(match[1]);
  if (match[2] === "") return { offset };
  const end = Number(match[2]);
  if (end < offset) return null;
  return { offset, length: end - offset + 1 };
}

// Local dev only: wrangler's simulated R2/KV stores are empty, but media
// written by the production pipeline lives in the real bucket. Proxy those
// requests to production so local pages can render real uploads. The
// hostname guard means this never runs on the deployed site.
async function devFallbackOr404(context, key) {
  const host = new URL(context.request.url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") return new Response("Not found", { status: 404 });
  const headers = {};
  const range = context.request.headers.get("range");
  if (range) headers.range = range;
  const upstream = await fetch(`https://otratickets.com/override-images/${key}`, { headers });
  if (!upstream.ok && upstream.status !== 206) return new Response("Not found", { status: 404 });
  return new Response(upstream.body, upstream);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
