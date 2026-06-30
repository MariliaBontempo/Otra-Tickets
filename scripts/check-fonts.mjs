import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["index.html", "events.html", "clearboat.html"];
const WEIGHTS = [400, 500, 600, 700, 800, 900];
const MAX_BYTES = 40960;

const failures = [];

function fail(msg) {
  failures.push(msg);
}

for (const page of PAGES) {
  const src = readFileSync(resolve(ROOT, page), "utf8");

  // No Google Fonts origins allowed
  if (src.includes("fonts.googleapis.com")) fail(`${page}: contains fonts.googleapis.com`);
  if (src.includes("fonts.gstatic.com")) fail(`${page}: contains fonts.gstatic.com`);

  // No Google origin preconnect/dns-prefetch
  if (/rel=["']preconnect["'][^>]*fonts\.(googleapis|gstatic)/.test(src) ||
      /fonts\.(googleapis|gstatic)[^>]*rel=["']preconnect["']/.test(src)) {
    fail(`${page}: has preconnect to Google Fonts origin`);
  }
  if (/rel=["']dns-prefetch["'][^>]*fonts\.(googleapis|gstatic)/.test(src) ||
      /fonts\.(googleapis|gstatic)[^>]*rel=["']dns-prefetch["']/.test(src)) {
    fail(`${page}: has dns-prefetch to Google Fonts origin`);
  }

  // CSS custom properties must be intact
  if (!src.includes('--font-display: "Inter", sans-serif;')) {
    fail(`${page}: --font-display token missing or changed`);
  }
  if (!src.includes('--font-body: "Inter", sans-serif;')) {
    fail(`${page}: --font-body token missing or changed`);
  }

  // Count @font-face blocks for Inter with font-display: swap
  const fontFaceRe = /@font-face\s*\{[^}]*font-family:\s*["']Inter["'][^}]*\}/gs;
  const blocks = src.match(fontFaceRe) || [];
  if (blocks.length < 6) {
    fail(`${page}: found ${blocks.length} Inter @font-face blocks, need >= 6`);
  }

  // Each block must have font-display: swap and a local woff2 src
  const woff2Refs = [];
  for (const block of blocks) {
    if (!block.includes("font-display: swap")) {
      fail(`${page}: @font-face block missing font-display: swap: ${block.slice(0, 80)}`);
    }
    const srcMatch = block.match(/src:\s*url\(["']?(fonts\/[^"')]+\.woff2)["']?\)/);
    if (!srcMatch) {
      fail(`${page}: @font-face block has no local woff2 src: ${block.slice(0, 80)}`);
    } else {
      woff2Refs.push(srcMatch[1]);
    }
  }

  // All referenced woff2 files must exist and be within size
  for (const ref of woff2Refs) {
    const abs = resolve(ROOT, ref);
    if (!existsSync(abs)) {
      fail(`${page}: referenced font file missing: ${ref}`);
      continue;
    }
    const sz = statSync(abs).size;
    if (sz === 0) fail(`${page}: ${ref} is empty`);
    if (sz > MAX_BYTES) fail(`${page}: ${ref} is ${sz} bytes (limit ${MAX_BYTES})`);
  }
}

// All 6 Inter woff2 files must exist and be within size
for (const w of WEIGHTS) {
  const rel = `fonts/inter-${w}.woff2`;
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) {
    fail(`${rel}: file missing`);
    continue;
  }
  const sz = statSync(abs).size;
  if (sz === 0) fail(`${rel}: empty`);
  if (sz > MAX_BYTES) fail(`${rel}: ${sz} bytes exceeds ${MAX_BYTES}`);
}

// Existing variable fonts must still be present
for (const f of ["fonts/Archivo-VariableFont_wdth_wght.ttf", "fonts/SpaceGrotesk-VariableFont_wght.ttf"]) {
  if (!existsSync(resolve(ROOT, f))) fail(`original font missing: ${f}`);
}

if (failures.length > 0) {
  for (const msg of failures) console.error("FAIL:", msg);
  process.exit(1);
}

console.log("FONTS: OK");
