// Cloudflare Pages Function: GET /override-media/<key>
//
// Public, cached serving of the images staff upload (stored in the R2 bucket
// bound as OVERRIDE_IMAGES). The editor's upload returns URLs under this path,
// which the public event pages then reference.

export async function onRequestGet(context) {
  const bucket = context.env.OVERRIDE_IMAGES;
  if (!bucket) return new Response("image store not configured", { status: 503 });

  const parts = context.params.path; // catch-all segments after /override-media/
  const key = Array.isArray(parts) ? parts.join("/") : String(parts || "");
  if (!key) return new Response("not found", { status: 404 });

  const object = await bucket.get(key);
  if (!object) return new Response("not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  return new Response(object.body, { headers });
}
