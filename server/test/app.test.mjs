import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { buildRouteTable } from "../router.js";

// A miniature functions dir exercising routing, env, params, waitUntil, fallback.
const dir = mkdtempSync(join(tmpdir(), "fx-"));
mkdirSync(join(dir, "api"), { recursive: true });
writeFileSync(join(dir, "api", "ping.js"), `
export async function onRequestGet(ctx) {
  ctx.waitUntil(Promise.resolve().then(() => { globalThis.__bg = true; }));
  return new Response(JSON.stringify({ ok: true, kv: await ctx.env.OVERRIDES.get("k") }),
    { headers: { "content-type": "application/json" } });
}`);
writeFileSync(join(dir, "[slug].js"), `
export async function onRequestGet(ctx) {
  if (ctx.params.slug === "fall") return ctx.env.ASSETS.fetch(ctx.request);
  return new Response("slug:" + ctx.params.slug);
}`);

const env = {
  OVERRIDES: { async get() { return "v"; } },
  ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
};
const routes = buildRouteTable(["api/ping.js", "[slug].js"]);
const app = createApp(env, routes, dir);

test("routes to function and surfaces waitUntil promises", async () => {
  const { response, background } = await app.handle(new Request("https://x.test/api/ping"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, kv: "v" });
  await Promise.allSettled(background);
  assert.equal(globalThis.__bg, true);
});
test("slug param and explicit ASSETS fallback", async () => {
  const a = await app.handle(new Request("https://x.test/hello"));
  assert.equal(await a.response.text(), "slug:hello");
  const b = await app.handle(new Request("https://x.test/fall"));
  assert.equal(await b.response.text(), "asset");
});
test("unrouted path serves assets; wrong method falls to assets", async () => {
  const a = await app.handle(new Request("https://x.test/api/ping/extra"));
  assert.equal(await a.response.text(), "asset");
  const b = await app.handle(new Request("https://x.test/api/ping", { method: "DELETE" }));
  assert.equal(await b.response.text(), "asset");
});
test("handler crash becomes 500", async () => {
  writeFileSync(join(dir, "boom.js"), `export function onRequestGet(){ throw new Error("x"); }`);
  const app2 = createApp(env, buildRouteTable(["boom.js"]), dir);
  const { response } = await app2.handle(new Request("https://x.test/boom"));
  assert.equal(response.status, 500);
});
test("malformed percent-encoding falls through to ASSETS as a 400, not a 500", async () => {
  const distDir = mkdtempSync(join(tmpdir(), "dist-"));
  const assetsEnv = {
    OVERRIDES: env.OVERRIDES,
    ASSETS: (await import("../assets.js")).createAssets(distDir, null),
  };
  const app3 = createApp(assetsEnv, routes, dir);
  const { response } = await app3.handle(new Request("https://x.test/%zz"));
  assert.equal(response.status, 400);
});
