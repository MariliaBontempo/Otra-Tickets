import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../app.js";
import { buildRouteTable } from "../router.js";
import {
  IMMUTABLE_CACHE_CONTROL,
  MAX_DISK_CACHE_BYTES,
  MAX_INPUT_PIXELS,
  MAX_ORIGINAL_BYTES,
  createImageTransform,
} from "../image-transform.js";
import { GUIDE_MEDIA_HOST } from "../../functions/_lib/responsive-image.js";

// /img/<width>/<source>.<format> (functions/img/[[path]].js) served through
// the real router with the sharp IMAGE_TRANSFORM binding: variants are WebP
// and width bound, cached, never proxy other hosts, never run video or ranged
// playback through sharp, and fall back to the original instead of failing.

const FUNCTIONS_DIR = join(import.meta.dirname, "..", "..", "functions");
const routes = buildRouteTable(["img/[[path]].js", "override-images/[[path]].js", "[slug].js"]);
const cacheDirs = [];
after(() => { for (const dir of cacheDirs) rmSync(dir, { recursive: true, force: true }); });

const fixture = await sharp({
  create: { width: 2000, height: 1000, channels: 3, background: { r: 200, g: 80, b: 40 } },
}).jpeg().toBuffer();

const KEY = "8267/ff768619.jpg";
const VARIANT = `/img/800/override-images/${KEY}.webp`;

function bucket(object, calls = []) {
  return {
    async get(key, opts) {
      calls.push({ key, opts });
      if (!object) return null;
      return {
        size: object.size ?? object.bytes.length,
        httpEtag: '"e"',
        body: new Blob([object.bytes]).stream(),
        writeHttpMetadata(headers) { headers.set("content-type", object.type); },
      };
    },
  };
}

function setup({ object = { bytes: fixture, type: "image/jpeg" }, transform, cacheDir, assets } = {}) {
  const calls = [];
  const dir = cacheDir === undefined ? mkdtempSync(join(tmpdir(), "img-cache-")) : cacheDir;
  if (dir) cacheDirs.push(dir);
  const env = {
    OVERRIDE_IMAGES: bucket(object, calls),
    ASSETS: assets || { async fetch() { return new Response("Not Found", { status: 404 }); } },
    IMAGE_TRANSFORM: transform === undefined ? createImageTransform({ cacheDir: dir, log() {} }) : transform,
  };
  const app = createApp(env, routes, FUNCTIONS_DIR);
  const get = async (path, init) => (await app.handle(new Request(`https://otratickets.com${path}`, init))).response;
  return { get, calls, dir };
}

test("override upload becomes a width-bound WebP with an immutable cache header", async () => {
  const { get } = setup();
  const res = await get(VARIANT);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get("content-length")), bytes.length);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 800);
  assert.equal(meta.height, 400);
  assert.ok(bytes.length < fixture.length, "the variant is smaller than the original");
});

test("encoded variants are cached in memory and on disk", async () => {
  const { get, calls, dir } = setup();
  const first = await get(VARIANT);
  assert.equal(first.headers.get("x-image-cache"), "miss");
  const second = await get(VARIANT);
  assert.equal(second.headers.get("x-image-cache"), "memory");
  assert.equal(calls.length, 1, "the original is read once");

  // A restarted server (fresh memory, same cache dir) still skips the encode.
  const restarted = setup({ cacheDir: dir });
  const third = await restarted.get(VARIANT);
  assert.equal(third.headers.get("x-image-cache"), "disk");
  assert.equal(restarted.calls.length, 0);
});

test("concurrent requests for one variant share a single encode", async () => {
  const { get, calls } = setup({ cacheDir: "" });
  const responses = await Promise.all([get(VARIANT), get(VARIANT), get(VARIANT)]);
  for (const res of responses) assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test("widths outside the allowlist clamp and formats outside it are rejected", async () => {
  const { get } = setup({ cacheDir: "" });
  const res = await get(`/img/5000/override-images/${KEY}.webp`);
  assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width, 1600);
  assert.equal((await get(`/img/800/override-images/${KEY}.gif`)).status, 400);
});

test("hosts and paths off the allowlist are rejected, never proxied", async () => {
  const { get, calls } = setup({ cacheDir: "" });
  for (const path of [
    "/img/800/example.com/photo.jpg.webp",
    "/img/800/https:/example.com/photo.jpg.webp",
    "/img/800/override-images/%2E%2E/secret.jpg.webp",
    "/img/800/assets/8088/presidente-photo.png.webp",
  ]) {
    assert.equal((await get(path)).status, 400, path);
  }
  assert.equal(calls.length, 0);
});

test("Guide media is fetched from its Spaces host only", async () => {
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(fixture, { headers: { "content-type": "image/jpeg" } });
  };
  try {
    const { get } = setup({ cacheDir: "" });
    const res = await get("/img/400/guide-media/media/images/full/abc.jpg.webp");
    assert.equal(res.status, 200);
    assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width, 400);
    assert.deepEqual(fetched, ["https://otraguide-prod-media-nyc3.nyc3.cdn.digitaloceanspaces.com/media/images/full/abc.jpg"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("static uploads are read through ASSETS", async () => {
  const seen = [];
  const assets = {
    async fetch(input) {
      seen.push(new URL(input.url || input).pathname);
      return new Response(fixture, { headers: { "content-type": "image/jpeg" } });
    },
  };
  const { get } = setup({ cacheDir: "", assets });
  const res = await get("/img/400/uploads/Otra%20Tickets%20Logo.webp.webp");
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["/uploads/Otra%20Tickets%20Logo.webp"]);
});

test("a video stored under an image name is redirected, not transformed", async () => {
  const { get } = setup({ object: { bytes: Buffer.from("not really video"), type: "video/mp4" }, cacheDir: "" });
  const res = await get(VARIANT);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/override-images/${KEY}`);
});

test("a ranged request never reaches the bucket as a range", async () => {
  const { get, calls } = setup({ cacheDir: "" });
  const res = await get(VARIANT, { headers: { range: "bytes=0-" } });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts, undefined);
});

test("an encode failure falls back to the original", async () => {
  const { get } = setup({ object: { bytes: Buffer.from("corrupt jpeg"), type: "image/jpeg" }, cacheDir: "" });
  const res = await get(VARIANT);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/override-images/${KEY}`);
});

test("missing sharp falls back to the original", async () => {
  const transform = createImageTransform({ loadSharp: () => Promise.reject(new Error("no sharp")), log() {} });
  const { get, calls } = setup({ transform, cacheDir: "" });
  const res = await get(VARIANT);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/override-images/${KEY}`);
  assert.equal(calls.length, 0, "the original is not loaded when it cannot be encoded");
});

test("without the transform binding the route redirects to the original", async () => {
  const { get } = setup({ transform: null, cacheDir: "" });
  const res = await get("/img/800/guide-media/media/images/full/abc.jpg.webp");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://otraguide-prod-media-nyc3.nyc3.cdn.digitaloceanspaces.com/media/images/full/abc.jpg");
});

test("a missing original is a 404", async () => {
  const { get } = setup({ object: null, cacheDir: "" });
  const res = await get(VARIANT);
  assert.equal(res.status, 404);
});

test("local dev encodes production originals through the override-images fallback", async () => {
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), range: init && init.headers && init.headers.range });
    return new Response(fixture, { headers: { "content-type": "image/jpeg" } });
  };
  try {
    const env = { IMAGE_TRANSFORM: createImageTransform({ log() {} }), ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
    const app = createApp(env, routes, FUNCTIONS_DIR);
    const { response } = await app.handle(new Request(`http://127.0.0.1:8788${VARIANT}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.deepEqual(fetched, [{ url: `https://otratickets.com/override-images/${KEY}`, range: undefined }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- production safety -------------------------------------------------------

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cacheDirs.push(dir);
  return dir;
}

// Wraps the real sharp so a test can see the options every call received.
function spySharp(seen) {
  const wrapped = (input, options) => {
    seen.push(options);
    return sharp(input, options);
  };
  return () => Promise.resolve(wrapped);
}

test("the limits are exported for callers and tests", () => {
  assert.equal(MAX_ORIGINAL_BYTES, 40 * 1024 * 1024);
  assert.ok(Number.isInteger(MAX_INPUT_PIXELS) && MAX_INPUT_PIXELS >= 48_000_000 && MAX_INPUT_PIXELS < 268_402_689,
    "pixel limit covers 48 MP phone photos and is tighter than the sharp default");
  assert.ok(Number.isInteger(MAX_DISK_CACHE_BYTES) && MAX_DISK_CACHE_BYTES > 0);
  assert.equal(IMMUTABLE_CACHE_CONTROL, "public, max-age=31536000, immutable");
});

test("an original whose content-length is over MAX_ORIGINAL_BYTES redirects without being read", async () => {
  const seen = [];
  const transform = createImageTransform({ loadSharp: spySharp(seen), log() {} });
  const { get, calls } = setup({ transform, object: { bytes: fixture, type: "image/jpeg", size: MAX_ORIGINAL_BYTES + 1 } });
  const res = await get(VARIANT);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/override-images/${KEY}`);
  assert.equal(calls.length, 1);
  assert.equal(seen.length, 0, "sharp never sees an oversized original");
});

test("an original without a content-length stops buffering at the byte limit", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Blob([fixture]).stream(), { headers: { "content-type": "image/jpeg" } });
  try {
    const seen = [];
    const transform = createImageTransform({ loadSharp: spySharp(seen), maxOriginalBytes: 1024, log() {} });
    const { get } = setup({ transform, cacheDir: "" });
    const res = await get("/img/400/guide-media/media/images/full/abc.jpg.webp");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `https://${GUIDE_MEDIA_HOST}/media/images/full/abc.jpg`);
    assert.equal(seen.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("sharp always gets an explicit limitInputPixels", async () => {
  const seen = [];
  const transform = createImageTransform({ loadSharp: spySharp(seen), log() {} });
  const { get } = setup({ transform, cacheDir: "" });
  const res = await get(VARIANT);
  assert.equal(res.status, 200);
  assert.ok(seen.length >= 1);
  for (const options of seen) assert.equal(options.limitInputPixels, MAX_INPUT_PIXELS);
});

test("an original over the pixel limit redirects to the original instead of decoding", async () => {
  const seen = [];
  const logs = [];
  // The fixture is 2000 x 1000 = 2 MP.
  const transform = createImageTransform({ loadSharp: spySharp(seen), maxInputPixels: 1_000_000, log: (...args) => logs.push(args.join(" ")) });
  const { get } = setup({ transform, cacheDir: "" });
  const res = await get(VARIANT);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/override-images/${KEY}`);
  assert.ok(logs.some((line) => line.includes("pixel limit")), logs.join("\n"));
  for (const options of seen) assert.equal(options.limitInputPixels, 1_000_000);
});

test("an unwritable cache dir still returns the encoded image with immutable headers", async () => {
  const parent = tempDir("img-cache-ro-");
  const blocker = join(parent, "not-a-dir");
  writeFileSync(blocker, "a file where the cache dir should be");
  const logs = [];
  const transform = createImageTransform({ cacheDir: join(blocker, "cache"), log: (...args) => logs.push(args.join(" ")) });
  const { get } = setup({ transform, cacheDir: "" });
  for (let i = 0; i < 2; i++) {
    const res = await get(VARIANT);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width, 800);
  }
  assert.ok(logs.some((line) => line.includes("cache write failed")), logs.join("\n"));
});

test("the disk cache evicts the oldest files once it is over the cap", async () => {
  // Byte sizes of the three variants, measured without a cap.
  const sizes = {};
  {
    const { get } = setup({ cacheDir: "" });
    for (const width of [400, 800, 1200]) {
      sizes[width] = (await (await get(`/img/${width}/override-images/${KEY}.webp`)).arrayBuffer()).byteLength;
    }
  }

  const dir = tempDir("img-cache-cap-");
  // Left over from an earlier process: an old variant, and a file the cache
  // does not own (never counted, never deleted).
  const stale = join(dir, `${"a".repeat(64)}.webp`);
  writeFileSync(stale, Buffer.alloc(4096));
  utimesSync(stale, new Date("2020-01-01"), new Date("2020-01-01"));
  writeFileSync(join(dir, "README"), "not a cache file");

  const transform = createImageTransform({ cacheDir: dir, maxDiskBytes: sizes[800] + sizes[1200], log() {} });
  const { get } = setup({ transform, cacheDir: "" });
  const total = () => readdirSync(dir).filter((f) => f !== "README").reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);

  for (const width of [400, 800, 1200]) {
    const res = await get(`/img/${width}/override-images/${KEY}.webp`);
    assert.equal(res.status, 200);
    await transform.flush();
    assert.ok(total() <= sizes[800] + sizes[1200], `cache within the cap after the ${width} write`);
  }
  const files = readdirSync(dir).sort();
  assert.ok(!files.includes(`${"a".repeat(64)}.webp`), "the stale variant was evicted first");
  assert.ok(files.includes("README"), "files the cache does not own are left alone");
  assert.equal(files.filter((f) => f.endsWith(".webp")).length, 2, "the oldest encoded variant (400) was evicted");
  assert.deepEqual(
    files.filter((f) => f.endsWith(".webp")).map((f) => statSync(join(dir, f)).size).sort((a, b) => a - b),
    [sizes[800], sizes[1200]].sort((a, b) => a - b),
  );

  // The evicted 400 variant is encoded again on the next request (no stale
  // index entry), and the cache stays within the cap.
  const again = await get(`/img/400/override-images/${KEY}.webp`);
  assert.equal(again.status, 200);
  await transform.flush();
  assert.ok(total() <= sizes[800] + sizes[1200]);
});

test("server/package.json pins the linux x64 sharp binary next to sharp", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const sharpVersion = pkg.dependencies.sharp;
  assert.match(sharpVersion, /^\d+\.\d+\.\d+$/, "sharp is pinned so the binary version cannot drift");
  const binary = (pkg.optionalDependencies || {})["@img/sharp-linux-x64"] || (pkg.dependencies || {})["@img/sharp-linux-x64"];
  assert.equal(binary, sharpVersion, "@img/sharp-linux-x64 matches sharp");

  const lock = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package-lock.json"), "utf8"));
  const root = lock.packages[""];
  assert.equal((root.optionalDependencies || root.dependencies)["@img/sharp-linux-x64"], sharpVersion, "lockfile root lists the binary (npm ci)");
  assert.equal(lock.packages["node_modules/sharp"].version, sharpVersion);
  assert.equal(lock.packages["node_modules/@img/sharp-linux-x64"].version, sharpVersion);
  assert.equal(lock.packages["node_modules/@img/sharp-linux-x64"].hasInstallScript, undefined, "the binary needs no install script");

  // The deploy keeps --ignore-scripts; the declared binary is what makes that safe.
  const deploy = readFileSync(join(import.meta.dirname, "..", "..", ".github", "workflows", "deploy.yml"), "utf8");
  assert.match(deploy, /npm --prefix server ci --omit=dev --ignore-scripts/);
});

test("fallback redirects only ever point at the allowlisted original", async () => {
  const transform = createImageTransform({ loadSharp: () => Promise.reject(new Error("no sharp")), log() {} });
  const { get, calls } = setup({ transform, cacheDir: "" });
  const expected = {
    [`/img/800/override-images/${KEY}.webp`]: `/override-images/${KEY}`,
    "/img/400/uploads/Otra%20Tickets%20Logo.webp.webp": "/uploads/Otra%20Tickets%20Logo.webp",
    "/img/1600/guide-media/media/images/full/abc.jpg.webp": `https://${GUIDE_MEDIA_HOST}/media/images/full/abc.jpg`,
    // Encoded tricks stay inside the allowlisted prefix or the Guide host.
    "/img/800/uploads/..%2F..%2Fsecret.jpg.webp": "/uploads/..%2F..%2Fsecret.jpg",
    "/img/800/guide-media/@evil.example/x.jpg.webp": `https://${GUIDE_MEDIA_HOST}/%40evil.example/x.jpg`,
  };
  for (const [path, location] of Object.entries(expected)) {
    const res = await get(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("location"), location, path);
  }
  for (const path of [
    "/img/800//evil.example/x.jpg.webp",
    "/img/800/https%3A%2F%2Fevil.example%2Fx.jpg.webp",
    "/img/800/%2F%2Fevil.example/x.jpg.webp",
    "/img/800/guide-media/../x.jpg.webp",
    "/img/800/uploads/variants/mosaic-hero-800.webp.webp",
    "/img/800/override-images/8267/clip.mp4.webp",
  ]) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.equal(res.headers.get("location"), null, path);
  }
  assert.equal(calls.length, 0);
});
