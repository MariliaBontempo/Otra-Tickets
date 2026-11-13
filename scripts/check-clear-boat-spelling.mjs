#!/usr/bin/env node
// Clear Boat is always written as two words in visible copy. The /clearboat
// URL, slug, filenames, assets and partner email/domain stay one lowercase word.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const URL_CLEARBOAT = "https://otratickets.com/clearboat";
const BRAND = "Clear Boat";

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(rel) {
  const path = join(root, rel);
  if (!existsSync(path)) {
    fail(`${rel}: file missing`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function decode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function metaContent(html, attr, name) {
  const re = new RegExp(`<meta\\s+[^>]*${attr}=["']${name}["'][^>]*content=(?:"([^"]*)"|'([^']*)')[^>]*>`, "i");
  const m = html.match(re);
  return m ? decode(m[1] ?? m[2]) : null;
}

function imgAlt(html, srcFragment) {
  const re = new RegExp(`<img\\b[^>]*src=["'][^"']*${srcFragment}[^"']*["'][^>]*>`, "i");
  const tag = html.match(re);
  if (!tag) return null;
  const alt = tag[0].match(/\balt=(?:"([^"]*)"|'([^']*)')/i);
  return alt ? decode(alt[1] ?? alt[2]) : null;
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

function stripJsComments(text) {
  return stripCssComments(text)
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function checkPage(rel) {
  const html = read(rel);
  if (!html) return;

  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
  assert(title && decode(title).includes(BRAND), `${rel}: <title> must say "${BRAND}" (got ${JSON.stringify(title)})`);

  for (const [attr, name] of [
    ["name", "description"],
    ["property", "og:title"],
    ["property", "og:description"],
    ["name", "twitter:title"],
    ["name", "twitter:description"],
  ]) {
    const value = metaContent(html, attr, name);
    assert(value && value.includes(BRAND), `${rel}: meta ${name} must say "${BRAND}" (got ${JSON.stringify(value)})`);
  }

  const ldRaw = (html.match(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/i) || [])[1];
  let ld = null;
  try {
    ld = ldRaw ? JSON.parse(ldRaw) : null;
  } catch (error) {
    fail(`${rel}: JSON-LD does not parse: ${error.message}`);
  }
  if (!ld) {
    fail(`${rel}: JSON-LD block missing`);
  } else {
    assert(String(ld.name || "").includes(BRAND), `${rel}: JSON-LD name must say "${BRAND}" (got ${JSON.stringify(ld.name)})`);
    assert(String(ld.description || "").includes(BRAND), `${rel}: JSON-LD description must say "${BRAND}"`);
    assert(ld.url === URL_CLEARBOAT, `${rel}: JSON-LD url must stay ${URL_CLEARBOAT} (got ${JSON.stringify(ld.url)})`);
    assert(ld.offers && ld.offers.url === URL_CLEARBOAT, `${rel}: JSON-LD offers.url must stay ${URL_CLEARBOAT}`);
  }

  const h1 = html.match(/<h1\s+id=["']evTitle["'][^>]*>([\s\S]*?)<\/h1>/i);
  assert(h1, `${rel}: <h1 id="evTitle"> missing (admin overrides target it)`);
  if (h1) assert(decode(h1[1]).trim() === BRAND, `${rel}: H1 #evTitle must be "${BRAND}" (got ${JSON.stringify(h1[1])})`);

  for (const src of ["clearboat-hero-", "clearboat-story1-", "clearboat-video-", "clearboat-photoband-"]) {
    const alt = imgAlt(html, src);
    assert(alt && alt.includes(BRAND), `${rel}: alt of ${src}* image must say "${BRAND}" (got ${JSON.stringify(alt)})`);
  }

  assert(html.includes("This is the main Clear Boat experience"), `${rel}: story copy must say "main Clear Boat experience"`);

  // No one-word brand anywhere visible. Lowercase URLs/assets are fine;
  // CSS/JS comments are ignored, but string literals in style/script still count.
  const styles = [];
  const scripts = [];
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, body) => {
      styles.push(body);
      return "";
    })
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, body) => {
      scripts.push(body);
      return "";
    });
  const sources = [
    ["markup", markup],
    ["<style>", stripCssComments(styles.join("\n"))],
    ["<script>", stripJsComments(scripts.join("\n"))],
  ];
  for (const [label, text] of sources) {
    for (const bad of ["Clearboat", "CLEARBOAT"]) {
      const idx = text.indexOf(bad);
      if (idx !== -1) {
        fail(`${rel}: ${label} still contains "${bad}" near ${JSON.stringify(text.slice(Math.max(0, idx - 40), idx + 40))}`);
      }
    }
  }

  // Guards: URL, canonical and assets stay one lowercase word.
  assert(
    new RegExp(`<link\\s+[^>]*rel=["']canonical["'][^>]*href=["']${URL_CLEARBOAT}["']`, "i").test(html),
    `${rel}: canonical must stay ${URL_CLEARBOAT}`,
  );
  assert(metaContent(html, "property", "og:url") === URL_CLEARBOAT, `${rel}: og:url must stay ${URL_CLEARBOAT}`);
  assert(html.includes("uploads/variants/clearboat-hero-1600.webp"), `${rel}: hero asset uploads/variants/clearboat-hero-1600.webp must stay referenced`);
  assert(html.includes("Currently the only clear boat operating in Curaçao"), `${rel}: phrase "Currently the only clear boat operating in Curaçao" must stay`);
}

// a) clearboat.html (source and built copy when present)
checkPage("clearboat.html");
if (existsSync(join(root, "dist", "clearboat.html"))) checkPage("dist/clearboat.html");

// b) llms.txt
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network disabled in check:clear-boat-spelling");
  };
  try {
    const mod = await import(pathToFileURL(join(root, "functions", "llms.txt.js")).href);
    const response = await mod.onRequestGet({
      request: new Request("https://otratickets.com/llms.txt"),
      env: {},
      waitUntil() {},
    });
    const body = await response.text();
    assert(
      body.split("\n").includes(`- Clear Boat: ${URL_CLEARBOAT}`),
      `llms.txt must list "- Clear Boat: ${URL_CLEARBOAT}"`,
    );
    assert(!body.includes("Clearboat"), `llms.txt must not say "Clearboat"`);
  } catch (error) {
    fail(`llms.txt onRequestGet threw: ${error.message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// c) admin page list label
{
  const src = read("functions/admin/api/pages.js");
  const entry = src.match(/\{\s*id:\s*"6113"[^}]*\}/);
  assert(entry, `functions/admin/api/pages.js: MANUAL_PAGES entry 6113 missing`);
  if (entry) {
    const title = (entry[0].match(/title:\s*"([^"]*)"/) || [])[1];
    const url = (entry[0].match(/url:\s*"([^"]*)"/) || [])[1];
    assert(title === BRAND, `functions/admin/api/pages.js: 6113 title must be "${BRAND}" (got ${JSON.stringify(title)})`);
    assert(url === "/clearboat.html", `functions/admin/api/pages.js: 6113 url must stay "/clearboat.html" (got ${JSON.stringify(url)})`);
  }
}

// d) admin Tours row note
{
  const src = read("admin/index.html");
  const line = src.split("\n").find((l) => /id === "tours-adventures"\)\s*return/.test(l)) || "";
  assert(line.includes("Clear Boat first"), `admin/index.html: tours-adventures note must say "Clear Boat first"`);
  assert(!line.includes("Clearboat"), `admin/index.html: tours-adventures note must not say "Clearboat"`);
}

// e) route/asset/partner guards
{
  const slug = read("functions/[slug].js");
  assert(slug.includes('"6113": "/clearboat"'), `functions/[slug].js must map "6113" -> "/clearboat"`);
  assert(slug.includes('"clearboat",'), `functions/[slug].js must keep the "clearboat" slug`);

  assert(read("functions/_lib/unlisted.js").includes('"clearboat"'), `functions/_lib/unlisted.js must keep "clearboat"`);

  const sitemap = read("functions/sitemap.xml.js");
  assert(sitemap.includes('path: "/clearboat"'), `functions/sitemap.xml.js must keep path "/clearboat"`);
  assert(sitemap.includes('"6113": "/clearboat"'), `functions/sitemap.xml.js must map "6113" -> "/clearboat"`);

  assert(read("functions/llms.txt.js").includes('"6113": "/clearboat"'), `functions/llms.txt.js SPECIAL_EVENT_PATHS must map "6113" -> "/clearboat"`);

  assert(
    read("site-overrides.js").includes("/\\/clearboat(?:\\.html)?\\/?$/i"),
    `site-overrides.js must keep the /clearboat page regex`,
  );

  assert(existsSync(join(root, "uploads/variants/clearboat-hero-1600.webp")), `uploads/variants/clearboat-hero-1600.webp must exist`);
  assert(read("functions/_lib/homepage-feed.js").includes('"uploads/Clearboat Hero.webp"'), `homepage-feed.js must keep "uploads/Clearboat Hero.webp"`);
  assert(existsSync(join(root, "uploads/Clearboat Hero.webp")), `uploads/Clearboat Hero.webp must exist`);

  // Baseline measured on origin/main (a7dcaa2): each appears once, in clearboat.html.
  const PARTNER_BASELINE = { "clearboatcuracao@gmail.com": 1, "clearboatcuracao.com": 1 };
  for (const [needle, expected] of Object.entries(PARTNER_BASELINE)) {
    let count = 0;
    try {
      const out = execFileSync("git", ["grep", "-h", "-o", "-F", needle, "--", "."], { cwd: root, encoding: "utf8" });
      count = out.split("\n").filter(Boolean).length;
    } catch (error) {
      if (error.status !== 1) fail(`git grep ${needle} failed: ${error.message}`);
    }
    assert(count === expected, `"${needle}" occurrences in tracked files changed: ${count} (expected ${expected})`);
  }
}

if (failures.length) {
  console.error(`check:clear-boat-spelling failed (${failures.length}):`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log("check:clear-boat-spelling passed");
