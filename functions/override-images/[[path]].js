// Cloudflare Pages Function: GET /override-images/<key>

export async function onRequestGet(context) {
  if (!context.env.OVERRIDE_IMAGES) return new Response("R2 binding missing", { status: 500 });

  const param = context.params.path;
  const key = Array.isArray(param) ? param.join("/") : String(param || "");
  if (!key || key.includes("..")) return new Response("Not found", { status: 404 });

  const object = await context.env.OVERRIDE_IMAGES.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", headers.get("cache-control") || "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}
