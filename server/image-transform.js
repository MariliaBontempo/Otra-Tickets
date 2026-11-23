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
//
// Limits (exported so tests use the same numbers):
// - MAX_ORIGINAL_BYTES: larger originals are never buffered; they redirect.
// - MAX_INPUT_PIXELS: decompression bomb guard. The header is checked before
//   any pixel is decoded, and sharp gets the same value as limitInputPixels.
// - MAX_DISK_CACHE_BYTES: cacheDir is trimmed to this size after every
//   write, oldest files first (a disk hit refreshes a file's time).
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const MAX_ORIGINAL_BYTES = 40 * 1024 * 1024;
// 50 MP covers 48 MP phone photos; anything larger redirects to the original.
export const MAX_INPUT_PIXELS = 50_000_000;
export const MAX_MEMORY_CACHE_BYTES = 64 * 1024 * 1024;
export const MAX_DISK_CACHE_BYTES = 512 * 1024 * 1024;

const CONTENT_TYPES = { webp: "image/webp", avif: "image/avif", jpeg: "image/jpeg", png: "image/png" };
const ENCODE_OPTIONS = {
  webp: { quality: 78 },
  avif: { quality: 55, effort: 4 },
  jpeg: { quality: 80, mozjpeg: true },
  png: { compressionLevel: 9 },
};
// SVG would be rasterised and GIF loses its animation, so neither is resized.
const STILL_IMAGE = /^image\/(jpeg|png|webp|avif)\b/i;
// Only files this module wrote are counted or evicted.
const CACHE_FILE = /^[0-9a-f]{64}\.(webp|avif|jpeg|png)$/;

export function createImageTransform({
  loadSharp = defaultLoadSharp,
  cacheDir = "",
  maxMemoryBytes = MAX_MEMORY_CACHE_BYTES,
  maxDiskBytes = MAX_DISK_CACHE_BYTES,
  maxOriginalBytes = MAX_ORIGINAL_BYTES,
  maxInputPixels = MAX_INPUT_PIXELS,
  maxConcurrentEncodes = 2,
  log = console.error,
} = {}) {
  const memory = new Map(); // key -> Buffer, in least-recently-used order
  let memoryBytes = 0;
  const inFlight = new Map(); // key -> Promise<Buffer | null>
  const runEncode = limiter(maxConcurrentEncodes);
  let sharpPromise = null;
  // Disk index, file name -> { size, time }. Read from cacheDir on the first
  // write after start, then kept in step with this process's own writes.
  let disk = null;
  let diskBytes = 0;
  let diskQueue = Promise.resolve();
  // Never behind any time already in the index (scanned mtimes carry
  // sub-millisecond parts), so a later touch always sorts as newer.
  let latestTime = 0;
  const touchTime = () => (latestTime = Math.max(Date.now(), latestTime));

  // Moves name to the newest end of the index.
  function touchDisk(name, size) {
    const previous = disk.get(name);
    if (previous) {
      diskBytes -= previous.size;
      disk.delete(name);
    }
    disk.set(name, { size, time: touchTime() });
    diskBytes += size;
  }

  function getSharp() {
    sharpPromise ||= loadSharp().catch((e) => {
      log("image-transform: sharp unavailable, /img redirects to originals:", e && e.message);
      return null;
    });
    return sharpPromise;
  }

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

  async function fromDisk(file, name) {
    if (!file) return null;
    let bytes;
    try { bytes = await readFile(file); } catch { return null; }
    // Refresh recency so eviction drops cold variants first. Best effort.
    const now = new Date();
    utimes(file, now, now).catch(() => {});
    if (disk && disk.has(name)) touchDisk(name, disk.get(name).size);
    return bytes;
  }

  // Never fails a response: a missing or read-only cache dir only costs a
  // re-encode after the next restart. Writes and evictions run one at a time.
  function toDisk(file, name, bytes) {
    if (!file) return Promise.resolve();
    diskQueue = diskQueue.then(async () => {
      try {
        await mkdir(cacheDir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, file);
      } catch (e) {
        log("image-transform: cache write failed:", e.message);
        return;
      }
      try {
        await trackAndEvict(name, bytes.length);
      } catch (e) {
        log("image-transform: cache eviction failed:", e.message);
      }
    });
    return diskQueue;
  }

  async function loadDiskIndex() {
    const found = [];
    for (const entry of await readdir(cacheDir)) {
      if (!CACHE_FILE.test(entry)) continue;
      try {
        const info = await stat(join(cacheDir, entry));
        found.push([entry, { size: info.size, time: info.mtimeMs }]);
      } catch { /* removed meanwhile */ }
    }
    found.sort((a, b) => a[1].time - b[1].time);
    disk = new Map(found);
    diskBytes = found.reduce((sum, [, info]) => sum + info.size, 0);
    if (found.length) latestTime = Math.max(latestTime, found[found.length - 1][1].time);
  }

  async function trackAndEvict(name, size) {
    if (!disk) await loadDiskIndex();
    touchDisk(name, size);
    if (diskBytes <= maxDiskBytes) return;
    // Stable sort: equal times keep index order, which is touch order.
    const oldestFirst = [...disk.entries()].sort((a, b) => a[1].time - b[1].time);
    for (const [entry, info] of oldestFirst) {
      if (diskBytes <= maxDiskBytes) break;
      // The file just written goes last, so the cache keeps what was asked for.
      if (entry === name) continue;
      await unlink(join(cacheDir, entry)).catch(() => {});
      disk.delete(entry);
      diskBytes -= info.size;
    }
    if (diskBytes > maxDiskBytes && disk.has(name)) {
      await unlink(join(cacheDir, name)).catch(() => {});
      diskBytes -= disk.get(name).size;
      disk.delete(name);
    }
  }

  async function encode(variant, loadOriginal, file, name) {
    const sharp = await getSharp();
    if (!sharp) return { fallback: true };
    const original = await loadOriginal();
    if (!original || original.status === 404) {
      original?.body?.cancel().catch(() => {});
      return { notFound: true };
    }
    if (!original.ok) return { fallback: true };
    const type = original.headers.get("content-type") || "";
    const length = Number(original.headers.get("content-length") || 0);
    if (!STILL_IMAGE.test(type) || length > maxOriginalBytes) {
      original.body?.cancel().catch(() => {});
      if (length > maxOriginalBytes) log("image-transform: original over the byte limit:", variant.source, length);
      return { fallback: true };
    }
    // A missing or wrong content-length must not let an oversized original
    // into memory either: stop reading at the limit.
    const input = await readLimited(original, maxOriginalBytes);
    if (!input) {
      log("image-transform: original over the byte limit:", variant.source);
      return { fallback: true };
    }
    const options = { failOn: "error", limitInputPixels: maxInputPixels };
    let bytes;
    try {
      // Reads the header only, so a decompression bomb is refused before
      // decoding; limitInputPixels stops the decode if the header lied.
      const { width = 0, height = 0 } = await sharp(input, options).metadata();
      if (!width || !height || width * height > maxInputPixels) {
        log("image-transform: original over the pixel limit:", variant.source, `${width}x${height}`);
        return { fallback: true };
      }
      bytes = await sharp(input, options)
        .rotate() // apply EXIF orientation before the metadata is dropped
        .resize({ width: variant.width, withoutEnlargement: true })
        .toFormat(variant.format, ENCODE_OPTIONS[variant.format])
        .toBuffer();
    } catch (e) {
      log("image-transform: encode failed:", variant.source, e.message);
      return { fallback: true };
    }
    await toDisk(file, name, bytes);
    return { bytes };
  }

  return {
    // Resolves to true when sharp loaded (server/index.js logs it at start).
    async ready() {
      return Boolean(await getSharp());
    },
    // Resolves once queued cache writes and evictions have finished.
    flush() {
      return diskQueue;
    },
    async render(variant, loadOriginal) {
      const key = `${variant.width}/${variant.format}/${variant.source}`;
      const hash = createHash("sha256").update(key).digest("hex");
      const name = `${hash}.${variant.format}`;
      const file = cacheDir ? join(cacheDir, name) : "";
      let bytes = fromMemory(key);
      let cache = "memory";
      if (!bytes) {
        bytes = await fromDisk(file, name);
        cache = "disk";
      }
      if (!bytes) {
        if (!inFlight.has(key)) {
          // Loading the original counts against the limit too: the buffered
          // original is most of the memory an encode holds.
          const work = runEncode(() => encode(variant, loadOriginal, file, name));
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
          "cache-control": IMMUTABLE_CACHE_CONTROL,
          etag: `"${hash.slice(0, 32)}"`,
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

// The body as a Buffer, or null as soon as it passes max bytes.
async function readLimited(response, max) {
  if (!response.body) {
    const whole = Buffer.from(await response.arrayBuffer());
    return whole.length > max ? null : whole;
  }
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
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
