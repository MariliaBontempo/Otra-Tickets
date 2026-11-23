import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../app.js";
import { buildRouteTable } from "../router.js";
import { createImageTransform } from "../image-transform.js";

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
        size: object.bytes.length,
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
