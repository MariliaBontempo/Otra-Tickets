import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// The override-images/override-media handlers must put an explicit
// content-length on full-body bucket responses: the droplet otherwise streams
// them chunked, Cloudflare caches the 200 without a size, and then answers
// Range requests with the full body, which Safari refuses to play.

const fnDir = join(import.meta.dirname, "..", "..", "functions");
const images = await import(pathToFileURL(join(fnDir, "override-images", "[[path]].js")).href);
const media = await import(pathToFileURL(join(fnDir, "override-media", "[[path]].js")).href);

function stubObject(size) {
  return {
    size,
    httpEtag: '"abc"',
    body: "stream",
    writeHttpMetadata(headers) { headers.set("content-type", "video/mp4"); },
  };
}

function context(path, params, object) {
  return {
    params: { path: params },
    request: new Request(`https://otratickets.com${path}`),
    env: { OVERRIDE_IMAGES: { async get() { return object; } } },
  };
}

test("override-images: full-body bucket response carries content-length", async () => {
  const res = await images.onRequestGet(
    context("/override-images/draft-1/a.mp4", ["draft-1", "a.mp4"], stubObject(500)));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), "500");
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
});

test("override-images: ranged response still reports the partial length", async () => {
  const object = stubObject(500);
  object.range = { offset: 10, length: 5 };
  const ctx = context("/override-images/draft-1/a.mp4", ["draft-1", "a.mp4"], object);
  ctx.request = new Request("https://otratickets.com/override-images/draft-1/a.mp4", {
    headers: { range: "bytes=10-14" },
  });
  const res = await images.onRequestGet(ctx);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-length"), "5");
  assert.equal(res.headers.get("content-range"), "bytes 10-14/500");
});

test("override-media: full-body bucket response carries content-length", async () => {
  const res = await media.onRequestGet(
    context("/override-media/draft-1/b.mp4", ["draft-1", "b.mp4"], stubObject(42)));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), "42");
});
