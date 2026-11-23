// Responsive storefront images: one helper for the event page, the homepage
// cards, the slug page head and the /img transform route.
//
// Variant URLs are same-origin paths served by functions/img/[[path]].js:
//   /img/<width>/<source path>.<format>
//   /img/800/override-images/8267/ff76.jpg.webp
//   /img/800/guide-media/media/images/full/x.jpg.webp  (Guide Spaces host)
// The output format is the last extension, so Cloudflare caches variants at
// the edge by extension like any other image, and the source path stays
// readable for debugging.
//
// Only allowlisted sources are rewritten (OT override uploads, OT static
// uploads, Guide media). Everything else (empty, data:/blob:, other hosts,
// videos, already-built variants) is returned unchanged, so a caller can pass
// any value through without checking it first.
//
// This file is also served to the browser as /responsive-image.js (copied by
// scripts/build-pages.mjs), so it must stay free of Node imports.

export const VARIANT_WIDTHS = [400, 800, 1200, 1600];
export const VARIANT_FORMATS = ["webp", "avif", "jpeg", "png"];
export const GUIDE_MEDIA_HOST = "otraguide-prod-media-nyc3.nyc3.cdn.digitaloceanspaces.com";

const VARIANT_PREFIX = "/img/";
const GUIDE_MEDIA_PREFIX = "/guide-media/";
const LOCAL_PREFIXES = ["/override-images/", "/uploads/"];
// uploads/variants/ already holds prebuilt AVIF/WebP width sets.
const PREBUILT_PREFIX = "/uploads/variants/";
const SITE_HOSTS = new Set(["otratickets.com", "www.otratickets.com"]);
const SITE_BASE = "https://otratickets.com/";
// Stills sharp can resize. GIF (may be animated), SVG and videos stay as-is.
const IMAGE_EXTENSION = /\.(jpe?g|png|webp|avif)$/i;
const META_SAFE_EXTENSION = /\.(jpe?g|png)$/i;
const FORMAT_ALIASES = { jpg: "jpeg" };
// Width for og:image / twitter:image when the original must be re-encoded.
const META_WIDTH = 1200;

// The smallest allowlisted width that covers the request (the largest one
// above the range), so a variant is never upscaled by the browser.
export function clampWidth(width) {
  const value = Number(width) || 0;
  return VARIANT_WIDTHS.find((allowed) => allowed >= value) || VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
}

export function normalizeFormat(format) {
  const value = String(format || "").toLowerCase();
  const normalized = FORMAT_ALIASES[value] || value;
  return VARIANT_FORMATS.includes(normalized) ? normalized : "";
}

// "/override-images/..." | "/uploads/..." | "/guide-media/..." for a source
// the transform route accepts, else "".
function variantSource(url) {
  const value = typeof url === "string" ? url.trim() : "";
  if (!value || /^(data|blob):/i.test(value)) return "";
  let parsed;
  try {
    parsed = new URL(value, SITE_BASE);
  } catch {
    return "";
  }
  if (parsed.search || parsed.hash) return "";
  const path = parsed.pathname;
  if (!IMAGE_EXTENSION.test(path) || path.split("/").includes("..")) return "";
  if (parsed.protocol === "https:" && parsed.hostname === GUIDE_MEDIA_HOST) {
    return GUIDE_MEDIA_PREFIX + path.replace(/^\/+/, "");
  }
  if (!SITE_HOSTS.has(parsed.hostname) || parsed.protocol !== "https:") return "";
  if (path.startsWith(PREBUILT_PREFIX)) return "";
  return LOCAL_PREFIXES.some((prefix) => path.startsWith(prefix)) ? path : "";
}

export function isTransformable(url) {
  return Boolean(variantSource(url));
}

// Same-origin variant URL, or the original value when it cannot be converted.
export function variantUrl(url, { width = VARIANT_WIDTHS[1], format = "webp" } = {}) {
  const source = variantSource(url);
  const fmt = normalizeFormat(format);
  if (!source || !fmt) return typeof url === "string" ? url : "";
  return `${VARIANT_PREFIX}${clampWidth(width)}${source}.${fmt}`;
}

// "<url> 400w, <url> 800w, ..." or "" when the source is not convertible.
export function srcsetFor(url, { widths = VARIANT_WIDTHS, format = "webp" } = {}) {
  if (!isTransformable(url) || !normalizeFormat(format)) return "";
  return widths.map((width) => `${variantUrl(url, { width, format })} ${clampWidth(width)}w`).join(", ");
}

// Attribute string for markup built as HTML text: ` srcset="..." sizes="..."`,
// or "" so the caller's plain src is used as is.
export function srcsetAttributes(url, { sizes = "100vw", widths, format } = {}) {
  const srcset = srcsetFor(url, { widths, format });
  if (!srcset) return "";
  return ` srcset="${escapeAttribute(srcset)}" sizes="${escapeAttribute(sizes)}"`;
}

// Head preload for an LCP image whose srcset is assigned later by script.
// No href: browsers without imagesrcset would otherwise fetch the original.
export function preloadLinkHtml(url, { sizes = "100vw", widths, format = "webp" } = {}) {
  const srcset = srcsetFor(url, { widths, format });
  if (!srcset) return "";
  const type = `image/${normalizeFormat(format)}`;
  return `<link rel="preload" as="image" type="${type}" imagesrcset="${escapeAttribute(srcset)}" imagesizes="${escapeAttribute(sizes)}" fetchpriority="high" />`;
}

// og:image / twitter:image / emails: crawlers and mail clients need JPEG or
// PNG. JPEG/PNG originals (and anything not convertible) are returned
// unchanged; a WebP/AVIF original becomes a JPEG variant. Never pass a
// variantUrl() result here or into meta tags.
export function metaImageUrl(url) {
  const value = typeof url === "string" ? url : "";
  if (!value || !isTransformable(value)) return value;
  const path = new URL(value, SITE_BASE).pathname;
  if (META_SAFE_EXTENSION.test(path)) return value;
  return variantUrl(value, { width: META_WIDTH, format: "jpeg" });
}

// A variant for a full width CSS background, sized to the device pixels of
// the current viewport (CSS width x devicePixelRatio, rounded up to the next
// allowed width): 800 on a typical phone, not the 1600 desktop file. The
// 1600 default is only for callers without a window (server side).
export function viewportVariantUrl(url) {
  return variantUrl(url, { width: viewportPixelWidth() });
}

export function viewportPixelWidth() {
  if (typeof window === "undefined") return VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
  const root = typeof document !== "undefined" && document.documentElement;
  const cssWidth = window.innerWidth || (root && root.clientWidth) || 0;
  return Math.ceil(cssWidth * (window.devicePixelRatio || 1));
}

// Points an <img> at url with a WebP srcset. src stays the original: it is the
// fallback for browsers without srcset, and site-overrides.js compares it to
// tell whether a slot already shows a value. The element is kept as a bare
// <img> (no <picture> wrapper) because saved editor overrides address slots
// by child selectors such as "section:nth-of-type(1) > img".
export function setResponsiveImage(img, url, { sizes, widths } = {}) {
  const srcset = srcsetFor(url, { widths });
  if (srcset) {
    img.sizes = sizes || img.getAttribute("sizes") || "100vw";
    img.srcset = srcset;
  } else {
    img.removeAttribute("srcset");
  }
  img.src = url;
}

// Inverse of variantUrl() for the transform route. segments are the decoded
// path segments after /img/. Returns { width, format, source } where source is
// a same-origin path or an absolute Guide media URL, or null when the request
// is not an allowlisted image.
export function parseVariantPath(segments) {
  const parts = Array.isArray(segments) ? segments.map(String) : String(segments || "").split("/");
  if (parts.length < 3 || !/^\d+$/.test(parts[0])) return null;
  const last = parts[parts.length - 1];
  const dot = last.lastIndexOf(".");
  const format = dot > 0 ? normalizeFormat(last.slice(dot + 1)) : "";
  if (!format) return null;
  const rest = [...parts.slice(1, -1), last.slice(0, dot)];
  if (rest.some((part) => !part || part === "." || part === "..")) return null;
  const encoded = "/" + rest.map(encodeURIComponent).join("/");
  const source = encoded.startsWith(GUIDE_MEDIA_PREFIX)
    ? `https://${GUIDE_MEDIA_HOST}/${encoded.slice(GUIDE_MEDIA_PREFIX.length)}`
    : encoded;
  // Round-trip through the same allowlist the pages use.
  if (!variantSource(source)) return null;
  return { width: clampWidth(parts[0]), format, source };
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
