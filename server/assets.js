// Cloudflare Pages ASSETS binding shim over the built dist/ directory.
// The consumer is functions/[slug].js, which calls
// context.env.ASSETS.fetch(context.request) (a Request) for static paths and
// context.env.ASSETS.fetch(new URL(assetPath, context.request.url)) (a bare
// URL) for pretty event pages, so fetch() must accept both input shapes.
import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { Readable } from "node:stream";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".gif": "image/gif", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
};

// Minimal Cloudflare Pages _headers parser: blocks of "<path pattern>" then
// indented "Header: value" lines. The repo's _headers file uses both a
// trailing "*" glob (/uploads/*) and a mid-pattern "*" with a suffix
// (/*.html), so matches() supports a single "*" anywhere in the pattern.
function parseHeaderRules(file) {
  if (!file || !existsSync(file)) return [];
  const rules = [];
  let current = null;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!raw.startsWith(" ") && !raw.startsWith("\t")) {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const idx = raw.indexOf(":");
      if (idx > 0) current.headers.push([raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()]);
    }
  }
  return rules;
}
function matches(pattern, path) {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === path;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return path.length >= prefix.length + suffix.length
    && path.startsWith(prefix) && path.endsWith(suffix);
}

export function createAssets(distDir, headersFile) {
  const rules = parseHeaderRules(headersFile);
  return {
    async fetch(input) {
      const url = input instanceof URL ? input : new URL(input.url);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Bad Request", { status: 400 }); }
      let rel = normalize(pathname).replace(/^\/+/, "");
      if (rel.includes("..")) return new Response("Not Found", { status: 404 });
      let file = join(distDir, rel === "" ? "index.html" : rel);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file) && !extname(file)) file = file + ".html"; // /event -> event.html
      if (!existsSync(file) || !statSync(file).isFile()) return new Response("Not Found", { status: 404 });
      const headers = new Headers({ "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
      for (const rule of rules)
        if (matches(rule.pattern, pathname))
          for (const [k, v] of rule.headers) headers.set(k, v);
      return new Response(Readable.toWeb(createReadStream(file)), { status: 200, headers });
    },
  };
}
