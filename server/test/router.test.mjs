import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRouteTable, resolveRoute } from "../router.js";

const FILES = [
  "[slug].js", "sitemap.xml.js", "robots.txt.js", "llms.txt.js",
  "_lib/homepage-feed.js", "admin/api/_auth.js", "admin/api/login.js",
  "admin/api/events.js", "api/homepage-events.js",
  "override-images/[[path]].js", "override-media/[[path]].js",
];
const routes = buildRouteTable(FILES);

test("static route wins", () => {
  assert.deepEqual(resolveRoute(routes, "/api/homepage-events"),
    { modulePath: "api/homepage-events.js", params: {} });
});
test("slug matches single segment only", () => {
  assert.deepEqual(resolveRoute(routes, "/kaya-kaya"),
    { modulePath: "[slug].js", params: { slug: "kaya-kaya" } });
  assert.equal(resolveRoute(routes, "/"), null);
  assert.equal(resolveRoute(routes, "/a/b"), null);
});
test("catchall collects segments", () => {
  assert.deepEqual(resolveRoute(routes, "/override-images/x/y.png"),
    { modulePath: "override-images/[[path]].js", params: { path: ["x", "y.png"] } });
});
test("underscore files are not routed", () => {
  assert.equal(resolveRoute(routes, "/admin/api/_auth"), null);
  const hit = resolveRoute(routes, "/admin/api/login");
  assert.equal(hit.modulePath, "admin/api/login.js");
});
test("static file names with dots route exactly", () => {
  assert.equal(resolveRoute(routes, "/sitemap.xml").modulePath, "sitemap.xml.js");
});
test("decodes percent-encoding in params", () => {
  assert.deepEqual(resolveRoute(routes, "/caf%C3%A9").params, { slug: "café" });
});
