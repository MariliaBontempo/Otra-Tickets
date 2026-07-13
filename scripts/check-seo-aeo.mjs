#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(rel) {
  const path = join(root, rel);
  if (!existsSync(path)) {
    fail(`${rel}: file missing`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function head(html) {
  const match = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return match ? match[1] : "";
}

function hasMetaDescription(value) {
  return /<meta\s+[^>]*name=["']description["'][^>]*content=["'][^"']{50,180}["'][^>]*>/i.test(value);
}

function hasCanonical(value, url) {
  const pattern = new RegExp(`<link\\s+[^>]*rel=["']canonical["'][^>]*href=["']${escapeRegExp(url)}["'][^>]*>`, "i");
  return pattern.test(value);
}

function hasOgAndTwitter(value) {
  return /property=["']og:title["']/i.test(value)
    && /property=["']og:description["']/i.test(value)
    && /property=["']og:url["']/i.test(value)
    && /property=["']og:image["']/i.test(value)
    && /name=["']twitter:card["']/i.test(value);
}

function hasJsonLd(value) {
  return /<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]+?<\/script>/i.test(value);
}

function hasNonEmptyH1(html) {
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .some((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length > 0);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const requiredFunctions = [
  "functions/robots.txt.js",
  "functions/sitemap.xml.js",
  "functions/llms.txt.js",
];

for (const rel of requiredFunctions) {
  const src = read(rel);
  if (!src) continue;
  if (!/content-type["']?\s*,\s*["']text\/plain|content-type["']?\s*,\s*["']application\/xml|content-type["']?\s*:\s*["']text\/plain|content-type["']?\s*:\s*["']application\/xml/i.test(src)) {
    fail(`${rel}: does not set an explicit text/xml content-type`);
  }
}

const robots = read("functions/robots.txt.js");
if (robots && !/Sitemap:\s*https:\/\/otratickets\.com\/sitemap\.xml/.test(robots)) {
  fail("functions/robots.txt.js: missing production sitemap reference");
}
if (robots && !/Disallow:\s*\/admin\//.test(robots)) {
  fail("functions/robots.txt.js: missing admin disallow");
}

const sitemap = read("functions/sitemap.xml.js");
if (sitemap && !/homepage-events/.test(sitemap)) {
  fail("functions/sitemap.xml.js: should derive event URLs from the homepage event feed");
}

const llms = read("functions/llms.txt.js");
if (llms && !/Otra Tickets/.test(llms)) {
  fail("functions/llms.txt.js: should identify Otra Tickets");
}

const pages = [
  { rel: "index.html", canonical: "https://otratickets.com/" },
  { rel: "events.html", canonical: "https://otratickets.com/events" },
  { rel: "clearboat.html", canonical: "https://otratickets.com/clearboat" },
  { rel: "rnb.html", canonical: "https://otratickets.com/rnb" },
];

for (const page of pages) {
  const html = read(page.rel);
  const htmlHead = head(html);
  if (!hasMetaDescription(htmlHead)) fail(`${page.rel}: missing 50-180 character meta description`);
  if (!hasCanonical(htmlHead, page.canonical)) fail(`${page.rel}: missing canonical ${page.canonical}`);
  if (!hasOgAndTwitter(htmlHead)) fail(`${page.rel}: missing Open Graph/Twitter metadata`);
  if (!hasJsonLd(htmlHead)) fail(`${page.rel}: missing JSON-LD structured data`);
  if (!hasNonEmptyH1(html)) fail(`${page.rel}: missing non-empty h1`);
}

const admin = read("admin/index.html");
if (admin && !/<meta\s+[^>]*name=["']robots["'][^>]*content=["']noindex,\s*nofollow["'][^>]*>/i.test(head(admin))) {
  fail("admin/index.html: missing noindex,nofollow robots meta");
}

const headers = read("_headers");
if (headers && !/\/admin\/\*\s+X-Robots-Tag:\s*noindex,\s*nofollow/is.test(headers)) {
  fail("_headers: missing /admin/* X-Robots-Tag noindex,nofollow");
}

const slugRoute = read("functions/[slug].js");
if (slugRoute) {
  for (const needle of ["application/ld+json", "og:title", "twitter:card", "rel=\"canonical\"", "name=\"description\""]) {
    if (!slugRoute.includes(needle)) fail(`functions/[slug].js: missing dynamic ${needle} injection`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error("FAIL:", failure);
  process.exit(1);
}

console.log("SEO/AEO: OK");
