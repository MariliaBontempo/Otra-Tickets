// GET /img/<width>/<source path>.<format>
//
// Width/format variants of allowlisted storefront images (see
// functions/_lib/responsive-image.js for the URL shape). The encoding itself
// is the IMAGE_TRANSFORM binding the Node server provides (server/
// image-transform.js, sharp). Without that binding (a Pages runtime, a local
// static server) the route redirects to the original, so variant URLs never
// break a page.
//
// Originals are loaded the same way their own routes serve them: override
// uploads through the override-images function (R2, then KV, then the local
// dev fallback to production), static uploads through ASSETS, Guide media
// from its Spaces host. The original request is always made without a Range
// header, so video playback ranges never reach the transform.

import { parseVariantPath } from "../_lib/responsive-image.js";
import { onRequestGet as getOverrideImage } from "../override-images/[[path]].js";

const OVERRIDE_PREFIX = "/override-images/";
const REDIRECT_CACHE = "public, max-age=300";

export async function onRequestGet(context) {
  const variant = parseVariantPath(context.params.path);
  if (!variant) {
    return new Response("Bad request", { status: 400, headers: { "cache-control": REDIRECT_CACHE } });
  }
  const transform = context.env.IMAGE_TRANSFORM;
  if (!transform) return redirectToOriginal(variant.source);
  // null: sharp missing, not a still image, or the encode failed.
  const encoded = await transform.render(variant, () => loadOriginal(context, variant.source));
  return encoded || redirectToOriginal(variant.source);
}

// Same-origin sources stay relative: the Node adapter rebuilds request URLs
// as https://, which is wrong for a local http server.
export function redirectToOriginal(source) {
  return new Response(null, {
    status: 302,
    headers: { location: source, "cache-control": REDIRECT_CACHE },
  });
}

function loadOriginal(context, source) {
  const url = new URL(source, context.request.url);
  if (url.origin !== new URL(context.request.url).origin) return fetch(url);
  const request = new Request(url);
  if (source.startsWith(OVERRIDE_PREFIX)) {
    const path = source.slice(OVERRIDE_PREFIX.length).split("/").map(decodeURIComponent);
    return getOverrideImage({ ...context, request, params: { path } });
  }
  return context.env.ASSETS.fetch(url);
}
