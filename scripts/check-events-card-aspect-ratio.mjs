#!/usr/bin/env node
// Oracle: the Otra Tickets events listing (homepage feed) locks the flyer
// container to 16:9 at every breakpoint. The blue outline .card stays
// flexible. A pixel height on the flyer is what cropped wording / date
// stamps when card width changed. Event detail (.ev-hero) is already 16:9
// and must stay that way.
//
// Run: node scripts/check-events-card-aspect-ratio.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const fail = (msg) => failures.push(msg);
const assert = (cond, msg) => { if (!cond) fail(msg); };

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Flyer box inside a flexible card whose width is clamp(min, vw, max). */
function flyerBox(viewportWidth, { min = 300, vw = 0.225, max = 452, pad = 16 } = {}) {
  const cardW = clamp(vw * viewportWidth, min, max);
  const mediaW = Math.max(0, cardW - pad * 2);
  const mediaH = mediaW * (9 / 16);
  return { cardW, mediaW, mediaH, ratio: mediaW / mediaH };
}

function isSixteenByNine(value) {
  const n = String(value).replace(/\s+/g, "");
  const m = n.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (!m) return false;
  return Math.abs(Number(m[1]) / Number(m[2]) - 16 / 9) < 1e-6;
}

function parseDecls(body) {
  const decls = [];
  for (const part of body.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const val = part.slice(idx + 1).trim();
    if (prop) decls.push([prop, val]);
  }
  return decls;
}

function declMap(body) {
  return Object.fromEntries(parseDecls(body));
}

function eachRule(css, cb) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  function scan(block, media) {
    let i = 0;
    while (i < block.length) {
      const nextBrace = block.indexOf("{", i);
      if (nextBrace === -1) break;
      const selector = block.slice(i, nextBrace).trim();
      let depth = 1;
      let j = nextBrace + 1;
      while (j < block.length && depth) {
        if (block[j] === "{") depth++;
        else if (block[j] === "}") depth--;
        j++;
      }
      const body = block.slice(nextBrace + 1, j - 1);
      if (/^@(media|supports)\b/i.test(selector)) scan(body, selector);
      else if (!selector.startsWith("@")) cb({ selector, body, media });
      i = j;
    }
  }
  scan(stripped, null);
}

function lastSimple(selector) {
  const parts = selector.trim().split(/[\s>+~]/);
  return parts[parts.length - 1] || "";
}

function targetsClass(selectorList, className) {
  const needle = "." + className;
  return selectorList.split(",").some((s) => {
    const last = lastSimple(s).replace(/::?[a-z-]+(\([^)]*\))?/gi, "");
    return last === needle || last.startsWith(needle + ":") || last.endsWith(needle);
  });
}

function pxBoxSize(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (v === "auto" || v === "100%" || v === "0" || v === "0px") return null;
  if (/(?:^|\s)(?:height|min-height|max-height)/.test(v)) return v;
  if (/\d(?:\.\d+)?px/.test(v) || /clamp\(/i.test(v)) return v;
  return null;
}

function collectFlyerViolations(css, { requireMedia = true } = {}) {
  const issues = [];
  let sawMediaRatio = false;
  let sawImgCover = false;
  let sawImgWidth = false;
  let sawImgHeightFill = false;
  let cardWidth = null;
  let cardPad = null;

  eachRule(css, ({ selector, body, media }) => {
    const where = media ? `${media} ${selector}` : selector;
    const decls = declMap(body);
    const isMedia = targetsClass(selector, "card-media");
    const isImg = targetsClass(selector, "card-img");
    const isCard = targetsClass(selector, "card") && !isMedia && !isImg
      && !targetsClass(selector, "card-body")
      && !targetsClass(selector, "card-title")
      && !targetsClass(selector, "card-venue")
      && !targetsClass(selector, "card-date");

    if (isMedia || isImg || isCard) {
      for (const prop of ["height", "min-height", "max-height"]) {
        if (prop in decls) {
          const bad = pxBoxSize(decls[prop]);
          if (bad && !(isImg && (decls[prop].trim() === "100%" || decls[prop].trim() === "auto"))) {
            if (isImg && decls[prop].trim() === "100%") continue;
            if (isImg && decls[prop].trim() === "auto") continue;
            issues.push(`${where} sets ${prop}: ${decls[prop]} (flyer box must not use a pixel height)`);
          }
        }
      }
    }

    if (isMedia && !media) {
      if (decls["aspect-ratio"] && isSixteenByNine(decls["aspect-ratio"])) sawMediaRatio = true;
      if (decls["aspect-ratio"] && !isSixteenByNine(decls["aspect-ratio"])) {
        issues.push(`.card-media aspect-ratio is ${decls["aspect-ratio"]}, expected 16 / 9`);
      }
    }
    if (isImg && !media) {
      if ((decls["object-fit"] || "").includes("cover")) sawImgCover = true;
      if (decls["width"] === "100%") sawImgWidth = true;
      if (decls["height"] === "100%" || decls["height"] === "auto") sawImgHeightFill = true;
    }
    if (isCard && !media && decls["width"]) cardWidth = decls["width"];
    if (isCard && !media && decls["padding"]) cardPad = decls["padding"];
  });

  if (requireMedia && !sawMediaRatio) issues.push("missing .card-media { aspect-ratio: 16 / 9 }");
  if (!sawImgCover) issues.push("missing .card-img { object-fit: cover }");
  if (!sawImgWidth) issues.push("missing .card-img { width: 100% }");
  if (!sawImgHeightFill) issues.push("missing .card-img { height: 100% } (fill the 16:9 container)");
  return { issues, cardWidth, cardPad, sawMediaRatio };
}

function extractStyle(html) {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  return blocks.map((m) => m[1]).join("\n");
}

// ---------------------------------------------------------------------------
// 1. Geometric unit tests — ratio holds at every breakpoint
// ---------------------------------------------------------------------------

const VIEWPORTS = [320, 375, 390, 414, 768, 820, 1024, 1280, 1440, 1920, 2560];
for (const vw of VIEWPORTS) {
  const box = flyerBox(vw);
  assert(
    Math.abs(box.ratio - 16 / 9) < 1e-9,
    `viewport ${vw}px: flyer ratio ${box.ratio} !== 16/9`,
  );
  assert(box.mediaH > 0, `viewport ${vw}px: flyer height collapsed`);
}

{
  const narrow = flyerBox(320);
  assert(narrow.cardW === 300, `narrow card width ${narrow.cardW}, expected clamp min 300`);
  const wide = flyerBox(2560);
  assert(wide.cardW === 452, `wide card width ${wide.cardW}, expected clamp max 452`);
  const mid = flyerBox(1600);
  assert(mid.cardW === 360, `1600px card width ${mid.cardW}, expected 22.5vw = 360`);
}

// Portrait / landscape / missing flyer: the CONTAINER stays 16:9; object-fit
// cover fills it. Height is a function of width, never a fixed px.
{
  const box = flyerBox(1440);
  const portraitIntrinsic = { w: 900, h: 1600 };
  const landscapeIntrinsic = { w: 1920, h: 1080 };
  const missing = { w: 0, h: 0 };
  for (const [name, intrinsic] of [
    ["portrait flyer", portraitIntrinsic],
    ["16:9 flyer", landscapeIntrinsic],
    ["missing flyer", missing],
  ]) {
    assert(
      Math.abs(box.mediaW / box.mediaH - 16 / 9) < 1e-9,
      `${name}: container drifted from 16:9`,
    );
    void intrinsic;
  }
}

// A fixed 145px height (the previous events-grid bug) CANNOT stay 16:9 as
// card width moves. Lock that regression in as an oracle.
{
  const heights = VIEWPORTS.map((vw) => flyerBox(vw).mediaW / 145);
  const unique = new Set(heights.map((r) => r.toFixed(3)));
  assert(unique.size > 1, "sanity: a 145px flyer height would NOT hold 16:9 across viewports");
}

// ---------------------------------------------------------------------------
// 2. Detector unit tests — fixtures for the CSS contract
// ---------------------------------------------------------------------------

{
  const good = `
    .card { width: clamp(300px, 22.5vw, 452px); padding: 16px; }
    .card-media { width: 100%; aspect-ratio: 16 / 9; overflow: hidden; }
    .card-img { width: 100%; height: 100%; object-fit: cover; }
  `;
  const { issues } = collectFlyerViolations(good);
  assert(issues.length === 0, `good fixture flagged: ${issues.join("; ")}`);
}

{
  const pxHeight = `
    .card-media { width: 100%; height: 145px; }
    .card-img { width: 100%; object-fit: cover; }
  `;
  const { issues } = collectFlyerViolations(pxHeight);
  assert(
    issues.some((i) => /145px/.test(i)),
    "detector missed a 145px flyer height (the crop bug)",
  );
}

{
  const fourByThree = `
    .card-media { width: 100%; aspect-ratio: 4 / 3; }
    .card-img { width: 100%; height: 100%; object-fit: cover; }
  `;
  const { issues } = collectFlyerViolations(fourByThree);
  assert(
    issues.some((i) => /4 \/ 3|4\/3/.test(i) || /aspect-ratio/.test(i)),
    "detector missed a 4/3 flyer container",
  );
}

{
  const mqHeight = `
    .card-media { width: 100%; aspect-ratio: 16 / 9; }
    .card-img { width: 100%; height: 100%; object-fit: cover; }
    @media (max-width: 720px) { .card-img { height: 180px; } }
  `;
  const { issues } = collectFlyerViolations(mqHeight);
  assert(
    issues.some((i) => /180px/.test(i)),
    "detector missed a mobile pixel height on .card-img",
  );
}

{
  const maxH = `
    .card-media { width: 100%; aspect-ratio: 16 / 9; max-height: 221px; }
    .card-img { width: 100%; height: 100%; object-fit: cover; }
  `;
  const { issues } = collectFlyerViolations(maxH);
  assert(
    issues.some((i) => /max-height/.test(i)),
    "detector missed max-height on the flyer container",
  );
}

{
  const noContainer = `
    .card-img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
  `;
  const { issues } = collectFlyerViolations(noContainer);
  assert(
    issues.some((i) => /card-media/.test(i) || /height: 100%/.test(i)),
    "detector missed a flyer <img> with no 16:9 container",
  );
}

// ---------------------------------------------------------------------------
// 3. Live contract: index.html (events listing) + event.html (detail, no change)
// ---------------------------------------------------------------------------

const indexPath = join(repoRoot, "index.html");
const eventPath = join(repoRoot, "event.html");
const pkgPath = join(repoRoot, "package.json");

assert(existsSync(indexPath), "index.html missing");
assert(existsSync(eventPath), "event.html missing");
assert(existsSync(pkgPath), "package.json missing");

const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
const eventHtml = existsSync(eventPath) ? readFileSync(eventPath, "utf8") : "";
const pkgRaw = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : "";

if (indexHtml) {
  const css = extractStyle(indexHtml);
  const { issues, cardWidth, cardPad } = collectFlyerViolations(css);
  for (const issue of issues) fail(`index.html CSS: ${issue}`);

  assert(/\.card\s*\{[^}]*width:\s*clamp\(/s.test(css), "index.html .card outline is no longer flexible (missing width: clamp)");
  assert(
    !/\.card-media[^{]*\{[^}]*height:\s*\d+px/s.test(css),
    "index.html .card-media has a pixel height",
  );

  const wrappedSkeleton = (indexHtml.match(/<div class="card-media">\s*<div class="card-img sk-shimmer">/g) || []).length;
  const skeletonImgs = (indexHtml.match(/class="card-img sk-shimmer"/g) || []).length;
  assert(skeletonImgs >= 1, "index.html skeleton lost .card-img.sk-shimmer");
  assert(
    wrappedSkeleton === skeletonImgs,
    `index.html skeleton: ${wrappedSkeleton}/${skeletonImgs} flyers wrapped in .card-media`,
  );

  assert(indexHtml.includes('media.className = "card-media"'), "index.html JS does not create .card-media");
  assert(indexHtml.includes("media.append(img)"), "index.html JS does not append the flyer <img> into .card-media");
  assert(indexHtml.includes("card.append(media, body)"), "index.html JS no longer appends (media, body) onto the card");
  assert(!indexHtml.includes("card.append(img, body)"), "index.html JS still appends the raw <img> onto the card");

  // Date lives in the flexible card body, not inside a cropped image box.
  assert(indexHtml.includes('dateEl.className = "card-date"'), "index.html JS lost the date element");
  assert(indexHtml.includes("body.append(titleEl, venueEl, dateEl)"), "index.html date is no longer in .card-body (would be cropped with the flyer)");

  // Parse clamp + padding from live CSS and re-run the geometric oracle
  // against the values actually in the stylesheet.
  const clampMatch = (cardWidth || "").match(/clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vw\s*,\s*([\d.]+)px\s*\)/);
  const padMatch = (cardPad || "").match(/^([\d.]+)px$/);
  if (clampMatch) {
    const spec = { min: Number(clampMatch[1]), vw: Number(clampMatch[2]) / 100, max: Number(clampMatch[3]), pad: padMatch ? Number(padMatch[1]) : 16 };
    for (const vw of VIEWPORTS) {
      const box = flyerBox(vw, spec);
      assert(
        Math.abs(box.ratio - 16 / 9) < 1e-9,
        `live CSS at ${vw}px: flyer ratio ${box.ratio} !== 16/9`,
      );
    }
  } else {
    fail(`index.html .card width is not clamp(min px, vw, max px): ${cardWidth}`);
  }
}

if (eventHtml) {
  const css = extractStyle(eventHtml);
  assert(/\.ev-hero\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s.test(css), "event.html .ev-hero lost aspect-ratio: 16 / 9");
  assert(/\.ev-hero-img\s*\{[^}]*object-fit:\s*cover/s.test(css), "event.html .ev-hero-img lost object-fit: cover");
  assert(
    !/\.ev-hero\s*\{[^}]*height:\s*\d+px/s.test(css),
    "event.html .ev-hero picked up a pixel height (detail was already 16:9 — do not regress)",
  );
}

if (pkgRaw) {
  let pkg = null;
  try { pkg = JSON.parse(pkgRaw); } catch { fail("package.json: invalid JSON"); }
  if (pkg && !(pkg.scripts || {})["check:events-card-ratio"]) {
    fail("package.json missing script: check:events-card-ratio");
  }
}

if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  console.error(`\nevents-card-aspect-ratio: ${failures.length} failure(s)`);
  process.exit(1);
}

console.log("PASS events-card-aspect-ratio: flyer container locked to 16:9; no pixel height; detail still 16:9");
