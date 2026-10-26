// Headers for an answer that no browser, proxy or CDN may keep: anything
// touching an unlisted (link only) page, so a toggle or a 404 is never
// masked by a copy cached before it.
//
// Cache-Control stays the bare "no-store" (callers and checks compare it).
// CDN-Cache-Control and Cloudflare-CDN-Cache-Control repeat it for the
// Cloudflare proxy in front of the droplet, so an edge cache rule that only
// respects origin headers cannot keep it either. Pragma/Expires cover old
// HTTP/1.0 caches. Validators are dropped so nothing can revalidate into a
// 304 against a copy taken while the page was listed. No Vary is needed:
// nothing is stored, so there is no variant to key.
export const NO_STORE = "no-store";

export function setNoStore(headers) {
  headers.set("cache-control", NO_STORE);
  headers.set("cdn-cache-control", NO_STORE);
  headers.set("cloudflare-cdn-cache-control", NO_STORE);
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.delete("etag");
  headers.delete("last-modified");
  headers.delete("age");
  return headers;
}
