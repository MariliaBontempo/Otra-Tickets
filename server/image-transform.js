// IMAGE_TRANSFORM binding for functions/img/[[path]].js: resizes and
// re-encodes an allowlisted original with sharp and caches the result.
//
// render() resolves to a Response, or to null when the original should be
// served instead (sharp missing, original not a still image, too large, or
// the encode failed); the route turns null into a redirect to the original.
//
// Cache: an in-memory LRU bounded by bytes, backed by files in cacheDir so a
// restart (every deploy) does not re-encode the whole storefront. Keys come
// from the variant URL; override-images keys are content-addressed uploads,
// and the response is immutable like the originals. Concurrent requests for
// the same variant share one encode, and encodes run a few at a time so a
// cold homepage (two dozen multi-MB originals) cannot exhaust droplet memory.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const IMMUTABLE = "public, max-age=31536000, immutable";
const CONTENT_TYPES = { webp: "image/webp", avif: "image/avif", jpeg: "image/jpeg", png: "image/png" };
const ENCODE_OPTIONS = {
  webp: { quality: 78 },
  avif: { quality: 55, effort: 4 },
  jpeg: { quality: 80, mozjpeg: true },
  png: { compressionLevel: 9 },
};
// SVG would be rasterised and GIF loses its animation, so neither is resized.
const STILL_IMAGE = /^image\/(jpeg|png|webp|avif)\b/i;
const MAX_ORIGINAL_BYTES = 40 * 1024 * 1024;

export function createImageTransform({
  loadSharp = defaultLoadSharp,
  cacheDir = "",
  maxMemoryBytes = 64 * 1024 * 1024,
  maxConcurrentEncodes = 2,
  log = console.error,
} = {}) {
  const memory = new Map(); // key -> Buffer, in least-recently-used order
  let memoryBytes = 0;
  const inFlight = new Map(); // key -> Promise<Buffer | null>
  const runEncode = limiter(maxConcurrentEncodes);
  let sharpPromise = null;

  function remember(key, bytes) {
    if (bytes.length > maxMemoryBytes) return;
    if (memory.has(key)) memoryBytes -= memory.get(key).length;
    memory.delete(key);
    memory.set(key, bytes);
    memoryBytes += bytes.length;
    for (const [oldKey, old] of memory) {
      if (memoryBytes <= maxMemoryBytes) break;
      memory.delete(oldKey);
      memoryBytes -= old.length;
    }
  }

  function fromMemory(key) {
    const bytes = memory.get(key);
    if (bytes) remember(key, bytes); // refresh recency
    return bytes;
  }

  async function fromDisk(file) {
    if (!file) return null;
    try { return await readFile(file); } catch { return null; }
  }

  async function toDisk(file, bytes) {
    if (!file) return;
    try {
      await mkdir(cacheDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    } catch (e) {
      log("image-transform: cache write failed:", e.message);
    }
  }

  async function encode(variant, loadOriginal, file) {
    const sharp = await (sharpPromise ||= loadSharp().catch(() => null));
    if (!sharp) return { fallback: true };
    const original = await loadOriginal();
    if (!original || original.status === 404) {
      original?.body?.cancel().catch(() => {});
      return { notFound: true };
    }
    if (!original.ok) return { fallback: true };
    const type = original.headers.get("content-type") || "";
    const length = Number(original.headers.get("content-length") || 0);
    if (!STILL_IMAGE.test(type) || length > MAX_ORIGINAL_BYTES) {
      original.body?.cancel().catch(() => {});
      return { fallback: true };
    }
    const input = Buffer.from(await original.arrayBuffer());
    if (input.length > MAX_ORIGINAL_BYTES) return { fallback: true };
    let bytes;
    try {
      bytes = await sharp(input, { failOn: "error" })
        .rotate() // apply EXIF orientation before the metadata is dropped
        .resize({ width: variant.width, withoutEnlargement: true })
        .toFormat(variant.format, ENCODE_OPTIONS[variant.format])
        .toBuffer();
    } catch (e) {
      log("image-transform: encode failed:", variant.source, e.message);
      return { fallback: true };
    }
    await toDisk(file, bytes);
    return { bytes };
  }

  return {
    async render(variant, loadOriginal) {
      const key = `${variant.width}/${variant.format}/${variant.source}`;
      const name = createHash("sha256").update(key).digest("hex");
      const file = cacheDir ? join(cacheDir, `${name}.${variant.format}`) : "";
      let bytes = fromMemory(key);
      let cache = "memory";
      if (!bytes) {
        bytes = await fromDisk(file);
        cache = "disk";
      }
      if (!bytes) {
        if (!inFlight.has(key)) {
          // Loading the original counts against the limit too: the buffered
          // original is most of the memory an encode holds.
          const work = runEncode(() => encode(variant, loadOriginal, file));
          inFlight.set(key, work.finally(() => inFlight.delete(key)));
        }
        const result = await inFlight.get(key);
        if (result.notFound) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=300" } });
        if (!result.bytes) return null;
        bytes = result.bytes;
        cache = "miss";
      }
      remember(key, bytes);
      return new Response(bytes, {
        headers: {
          "content-type": CONTENT_TYPES[variant.format],
          "content-length": String(bytes.length),
          "cache-control": IMMUTABLE,
          etag: `"${name.slice(0, 32)}"`,
          "x-image-cache": cache,
        },
      });
    },
  };
}

// sharp is a native module: a missing or broken install must degrade to
// originals, never take the server down.
async function defaultLoadSharp() {
  const mod = await import("sharp");
  return mod.default;
}

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    task().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    next();
  });
}
