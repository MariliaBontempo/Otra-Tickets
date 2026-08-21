import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssets } from "../assets.js";

const assets = createAssets(new URL("../../dist/", import.meta.url).pathname,
                            new URL("../../_headers", import.meta.url).pathname);

test("serves index.html at root with html content type", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});
test("404 for unknown path", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/definitely-not-here.xyz"));
  assert.equal(res.status, 404);
});
test("no path traversal", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/..%2f..%2fetc%2fpasswd"));
  assert.notEqual(res.status, 200);
});
test("accepts URL argument form used by [slug].js", async () => {
  const res = await assets.fetch(new URL("/event", "https://otratickets.com/x"));
  assert.equal([200, 404].includes(res.status), true); // 200 if dist/event.html exists
});

// --- Extensions driven by the repo's real _headers file (which has a
// wildcard NOT at the end of the pattern, "/*.html") and by functions/[slug].js
// (which serves "/admin" via ASSETS.fetch(context.request) and depends on
// directory-index taking priority over a same-named .html file).

test("/*.html header rule applies cache-control to an .html request", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/event.html"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
});
test("root '/' gets the same must-revalidate cache-control", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/"));
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
});
test("/uploads/* applies immutable cache-control, including nested variants/", async () => {
  const top = await assets.fetch(new Request("https://otratickets.com/uploads/R1C5.webp"));
  assert.equal(top.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const nested = await assets.fetch(new Request("https://otratickets.com/uploads/variants/flamingos-400.webp"));
  assert.equal(nested.status, 200);
  assert.equal(nested.headers.get("cache-control"), "public, max-age=31536000, immutable");
});
test("/fonts/* serves .ttf with a font content type and immutable caching", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/fonts/Archivo-VariableFont_wdth_wght.ttf"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /font/);
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
});
test("/admin/* gets the noindex robots header", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/admin/"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
});
test("extensionless /admin resolves the real admin app (directory index), not the admin.html redirect stub", async () => {
  // functions/[slug].js treats "admin" as a STATIC_PATHS entry and calls
  // context.env.ASSETS.fetch(context.request) with the original, extensionless
  // request. dist/admin.html is a legacy `location.replace("/admin/")` stub;
  // dist/admin/index.html is the real app. Directory-index must win.
  const res = await assets.fetch(new Request("https://otratickets.com/admin"));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body.includes('location.replace("/admin/")'), false);
  assert.match(body, /login-box|<textarea/);
});
