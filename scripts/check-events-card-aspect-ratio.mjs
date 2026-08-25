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

const VIEWPORTS = {
  mobile: [320, 375, 390, 414],
  tablet: [768, 820],
  desktop: [1024, 1280, 1440],
  ultrawide: [1920, 2560],
};
const ALL_VIEWPORTS = Object.values(VIEWPORTS).flat();
const RATIO_16_9 = 16 / 9;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Card/flyer widths from the live clamp(), independent of aspect-ratio. */
function flyerWidth(viewportWidth, { min = 300, vw = 0.225, max = 452, pad = 16 } = {}) {
  const cardW = clamp(vw * viewportWidth, min, max);
  const mediaW = Math.max(0, cardW - pad * 2);
  return { cardW, mediaW };
}

function isSixteenByNine(value) {
  if (value == null) return false;
  const n = String(value).replace(/\s+/g, "");
  const fraction = n.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const denom = Number(fraction[2]);
    if (!denom) return false;
    return Math.abs(Number(fraction[1]) / denom - RATIO_16_9) < 1e-6;
  }
  const numeric = Number(n);
  return Number.isFinite(numeric) && Math.abs(numeric - RATIO_16_9) < 1e-6;
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

function isRestingSelector(selectorList) {
  return selectorList.split(",").some((s) => !/:(hover|focus|active|focus-visible)/i.test(s));
}

function parsePx(value) {
  const m = String(value).trim().match(/^([\d.]+)px$/i);
  return m ? Number(m[1]) : null;
}

function splitTopLevel(str, sepChar) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (const ch of str) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sepChar && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function mediaMatchesViewport(mediaAtRule, viewportWidth) {
  if (!mediaAtRule) return true;
  if (/^@supports\b/i.test(mediaAtRule)) return true;
  const cond = mediaAtRule.replace(/^@media\s+/i, "").trim();
  return splitTopLevel(cond, ",").some((query) => matchOneMediaQuery(query, viewportWidth));
}

function matchOneMediaQuery(query, viewportWidth) {
  let s = query.trim();
  if (/^not\b/i.test(s)) return false;
  s = s.replace(/^(only\s+)?(screen|all|print)\s+and\s+/i, "");
  s = s.replace(/^(only\s+)?(screen|all|print)\s*$/i, "");
  if (!s.trim()) return true;

  const features = [...s.matchAll(/\(\s*(min-width|max-width|width|prefers-reduced-motion)\s*:\s*([^)]+)\)/gi)];
  if (!features.length) return false;

  for (const [, name, raw] of features) {
    const feature = name.toLowerCase();
    const value = raw.trim();
    if (feature === "prefers-reduced-motion") return false;
    const px = parsePx(value);
    if (px == null) return false;
    if (feature === "max-width" && viewportWidth > px) return false;
    if (feature === "min-width" && viewportWidth < px) return false;
    if (feature === "width" && viewportWidth !== px) return false;
  }
  return true;
}

function isForbiddenBoxHeight(value, { allowPercentFill = false } = {}) {
  if (value == null) return null;
  const v = String(value).trim();
  const lower = v.toLowerCase();
  if (lower === "auto" || lower === "unset" || lower === "initial" || lower === "none") return null;
  if (allowPercentFill && (lower === "100%" || lower === "0" || lower === "0px")) return null;
  if (lower === "0" || lower === "0px") return null;
  if (/\d(?:\.\d+)?px/i.test(v)) return v;
  if (/clamp\(/i.test(v)) return v;
  if (/calc\(/i.test(v)) return v;
  if (/\d(?:\.\d+)?(?:vw|vh|vmin|vmax|em|rem|%)/i.test(v)) return v;
  return v;
}

function isCardSelector(selector) {
  return targetsClass(selector, "card")
    && !targetsClass(selector, "card-media")
    && !targetsClass(selector, "card-img")
    && !targetsClass(selector, "card-body")
    && !targetsClass(selector, "card-title")
    && !targetsClass(selector, "card-venue")
    && !targetsClass(selector, "card-date");
}

/**
 * Cascade .card / .card-media / .card-img at a viewport. Source order, last
 * matching resting rule wins. Hover/focus rules are ignored here so the
 * resting flyer box is what we measure; collectFlyerViolations still scans them.
 */
function resolveFlyerStyles(css, viewportWidth) {
  const mediaDecls = {};
  const imgDecls = {};
  const cardDecls = {};

  eachRule(css, ({ selector, body, media }) => {
    if (!mediaMatchesViewport(media, viewportWidth)) return;
    if (!isRestingSelector(selector)) return;
    const decls = declMap(body);
    if (targetsClass(selector, "card-media")) Object.assign(mediaDecls, decls);
    if (targetsClass(selector, "card-img")) Object.assign(imgDecls, decls);
    if (isCardSelector(selector)) Object.assign(cardDecls, decls);
  });

  return {
    aspectRatio: mediaDecls["aspect-ratio"] || null,
    overflow: mediaDecls["overflow"] || null,
    overflowHidden: /\bhidden\b/i.test(mediaDecls["overflow"] || ""),
    objectFit: imgDecls["object-fit"] || null,
    objectFitCover: (imgDecls["object-fit"] || "").includes("cover"),
    imgWidth: imgDecls["width"] || null,
    imgHeight: imgDecls["height"] || null,
    mediaHeight: mediaDecls["height"] || null,
    mediaMinHeight: mediaDecls["min-height"] || null,
    mediaMaxHeight: mediaDecls["max-height"] || null,
    cardWidth: cardDecls["width"] || null,
    cardPad: cardDecls["padding"] || null,
  };
}

function collectFlyerViolations(css, { requireMedia = true } = {}) {
  const issues = [];
  let sawMediaRatio = false;
  let sawOverflowHidden = false;
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
    const isCard = isCardSelector(selector);

    if (isMedia || isImg || isCard) {
      for (const prop of ["height", "min-height", "max-height"]) {
        if (!(prop in decls)) continue;
        const bad = isForbiddenBoxHeight(decls[prop], { allowPercentFill: isImg });
        if (!bad) continue;
        issues.push(`${where} sets ${prop}: ${decls[prop]} (flyer box must not use a pixel height)`);
      }
    }

    if (isMedia) {
      if (decls["aspect-ratio"]) {
        if (isSixteenByNine(decls["aspect-ratio"])) {
          if (!media) sawMediaRatio = true;
        } else {
          issues.push(`${where} aspect-ratio is ${decls["aspect-ratio"]}, expected 16 / 9`);
        }
      }
      if (decls["overflow"]) {
        if (/\bhidden\b/i.test(decls["overflow"])) {
          if (!media) sawOverflowHidden = true;
        } else {
          issues.push(`${where} overflow is ${decls["overflow"]}, expected hidden`);
        }
      }
    }

    if (isImg) {
      if (decls["object-fit"] && !(decls["object-fit"] || "").includes("cover")) {
        issues.push(`${where} object-fit is ${decls["object-fit"]}, expected cover`);
      }
      if (!media) {
        if ((decls["object-fit"] || "").includes("cover")) sawImgCover = true;
        if (decls["width"] === "100%") sawImgWidth = true;
        if (decls["height"] === "100%" || decls["height"] === "auto") sawImgHeightFill = true;
      }
    }
    if (isCard && !media && decls["width"]) cardWidth = decls["width"];
    if (isCard && !media && decls["padding"]) cardPad = decls["padding"];
  });

  if (requireMedia && !sawMediaRatio) issues.push("missing .card-media { aspect-ratio: 16 / 9 }");
  if (requireMedia && !sawOverflowHidden) issues.push("missing .card-media { overflow: hidden }");
  if (!sawImgCover) issues.push("missing .card-img { object-fit: cover }");
  if (!sawImgWidth) issues.push("missing .card-img { width: 100% }");
  if (!sawImgHeightFill) issues.push("missing .card-img { height: 100% } (fill the 16:9 container)");
  return { issues, cardWidth, cardPad, sawMediaRatio, sawOverflowHidden };
}

function extractStyle(html) {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  return blocks.map((m) => m[1]).join("\n");
}

function assertFlyerLockAtViewports(css, viewports, label) {
  for (const vw of viewports) {
    const resolved = resolveFlyerStyles(css, vw);
    assert(
      isSixteenByNine(resolved.aspectRatio),
      `${label} at ${vw}px: aspect-ratio is ${resolved.aspectRatio}, expected 16 / 9`,
    );
    assert(
      resolved.overflowHidden,
      `${label} at ${vw}px: overflow is ${resolved.overflow}, expected hidden`,
    );
    assert(
      resolved.objectFitCover,
      `${label} at ${vw}px: object-fit is ${resolved.objectFit}, expected cover`,
    );
    assert(
      resolved.imgWidth === "100%",
      `${label} at ${vw}px: .card-img width is ${resolved.imgWidth}, expected 100%`,
    );
    assert(
      resolved.imgHeight === "100%" || resolved.imgHeight === "auto",
      `${label} at ${vw}px: .card-img height is ${resolved.imgHeight}, expected 100%`,
    );
    for (const [prop, value] of [
      ["height", resolved.mediaHeight],
      ["min-height", resolved.mediaMinHeight],
      ["max-height", resolved.mediaMaxHeight],
    ]) {
      const bad = isForbiddenBoxHeight(value);
      assert(!bad, `${label} at ${vw}px: .card-media ${prop} is ${value}`);
    }
  }
}

const GOOD_CSS = `
  .card { width: clamp(300px, 22.5vw, 452px); padding: 16px; }
  .card-media { width: 100%; aspect-ratio: 16 / 9; overflow: hidden; }
  .card-img { width: 100%; height: 100%; object-fit: cover; }
`;

// ---------------------------------------------------------------------------
// 1. CSS cascade at every breakpoint (parses real rules, not hardcoded 9/16)
// ---------------------------------------------------------------------------

{
  const { issues } = collectFlyerViolations(GOOD_CSS);
  assert(issues.length === 0, `good fixture flagged: ${issues.join("; ")}`);
  for (const [name, widths] of Object.entries(VIEWPORTS)) {
    assertFlyerLockAtViewports(GOOD_CSS, widths, `good fixture (${name})`);
  }
}

{
  const mqRatio = `
    ${GOOD_CSS}
    @media (max-width: 720px) { .card-media { aspect-ratio: 4 / 3; } }
  `;
  const { issues } = collectFlyerViolations(mqRatio);
  assert(
    issues.some((i) => /4\s*\/\s*3/.test(i)),
    "detector missed a media-query aspect-ratio override of 4 / 3",
  );
  const mobile = resolveFlyerStyles(mqRatio, 375);
  assert(!isSixteenByNine(mobile.aspectRatio), `cascade missed 4/3 at 375px (got ${mobile.aspectRatio})`);
  const desktop = resolveFlyerStyles(mqRatio, 1280);
  assert(isSixteenByNine(desktop.aspectRatio), `cascade lost base 16/9 at 1280px (got ${desktop.aspectRatio})`);
}

{
  const mqContain = `
    ${GOOD_CSS}
    @media (min-width: 1920px) { .card-img { object-fit: contain; } }
  `;
  const { issues } = collectFlyerViolations(mqContain);
  assert(
    issues.some((i) => /object-fit/.test(i) && /contain/.test(i)),
    "detector missed a media-query object-fit override",
  );
  const ultra = resolveFlyerStyles(mqContain, 2560);
  assert(!ultra.objectFitCover, `cascade missed contain at 2560px (got ${ultra.objectFit})`);
  const desktop = resolveFlyerStyles(mqContain, 1280);
  assert(desktop.objectFitCover, `cascade lost cover at 1280px (got ${desktop.objectFit})`);
}

{
  const noRatio = `
    .card { width: clamp(300px, 22.5vw, 452px); padding: 16px; }
    .card-media { width: 100%; overflow: hidden; }
    .card-img { width: 100%; height: 100%; object-fit: cover; }
  `;
  const { issues } = collectFlyerViolations(noRatio);
  assert(
    issues.some((i) => /aspect-ratio/.test(i)),
    "detector missed a missing aspect-ratio",
  );
  for (const vw of ALL_VIEWPORTS) {
    assert(
      !isSixteenByNine(resolveFlyerStyles(noRatio, vw).aspectRatio),
      `removed aspect-ratio still resolved as 16/9 at ${vw}px`,
    );
  }
}

{
  const changed = GOOD_CSS.replace("16 / 9", "1 / 1");
  const { issues } = collectFlyerViolations(changed);
  assert(
    issues.some((i) => /1\s*\/\s*1/.test(i) || /aspect-ratio/.test(i)),
    "detector missed aspect-ratio changed to 1 / 1",
  );
  assert(
    !isSixteenByNine(resolveFlyerStyles(changed, 1440).aspectRatio),
    "changed 1/1 ratio still counted as 16/9",
  );
}

// Clamp limits (width only). These read the clamp numbers, not the ratio.
{
  const narrow = flyerWidth(320);
  assert(narrow.cardW === 300, `narrow card width ${narrow.cardW}, expected clamp min 300`);
  const wide = flyerWidth(2560);
  assert(wide.cardW === 452, `wide card width ${wide.cardW}, expected clamp max 452`);
  const mid = flyerWidth(1600);
  assert(mid.cardW === 360, `1600px card width ${mid.cardW}, expected 22.5vw = 360`);
}

// A fixed 145px height (the previous events-grid bug) CANNOT stay 16:9 as
// card width moves. Lock that regression in as an oracle against CSS, not
// against a helper that already multiplies by 9/16.
{
  const pxHeight = `
    .card { width: clamp(300px, 22.5vw, 452px); padding: 16px; }
    .card-media { width: 100%; height: 145px; overflow: hidden; }
    .card-img { width: 100%; height: 100%; object-fit: cover; }
  `;
  const implied = ALL_VIEWPORTS.map((vw) => flyerWidth(vw).mediaW / 145);
  const unique = new Set(implied.map((r) => r.toFixed(3)));
  assert(unique.size > 1, "sanity: a 145px flyer height would NOT hold 16:9 across viewports");
  assert(
    implied.some((r) => Math.abs(r - RATIO_16_9) > 1e-6),
    "sanity: 145px height matched 16:9 at every clamp width",
  );
  const { issues } = collectFlyerViolations(pxHeight);
  assert(issues.some((i) => /145px/.test(i)), "detector missed a 145px flyer height (the crop bug)");
}

// ---------------------------------------------------------------------------
// 2. Detector unit tests — fixtures for the CSS contract
// ---------------------------------------------------------------------------

{
  const fourByThree = `
    .card-media { width: 100%; aspect-ratio: 4 / 3; overflow: hidden; }
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
    ${GOOD_CSS}
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
    .card-media { width: 100%; aspect-ratio: 16 / 9; max-height: 221px; overflow: hidden; }
    .card-img { width: 100%; height: 100%; object-fit: cover; }
  `;
  const { issues } = collectFlyerViolations(maxH);
  assert(
    issues.some((i) => /max-height/.test(i)),
    "detector missed max-height on the flyer container",
  );
}

{
  const calcHeight = `
    .card-media { width: 100%; aspect-ratio: 16 / 9; height: calc(100% - 1px); overflow: hidden; }
    .card-img { width: 100%; height: 100%; object-fit: cover; }
  `;
  const { issues } = collectFlyerViolations(calcHeight);
  assert(
    issues.some((i) => /calc\(/.test(i)),
    "detector missed a calc() height on the flyer container",
  );
}

{
  const noOverflow = `
    .card { width: clamp(300px, 22.5vw, 452px); padding: 16px; }
    .card-media { width: 100%; aspect-ratio: 16 / 9; }
    .card-img { width: 100%; height: 100%; object-fit: cover; }
  `;
  const { issues } = collectFlyerViolations(noOverflow);
  assert(
    issues.some((i) => /overflow/.test(i)),
    "detector missed missing overflow: hidden on .card-media",
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

  for (const [name, widths] of Object.entries(VIEWPORTS)) {
    assertFlyerLockAtViewports(css, widths, `index.html (${name})`);
  }

  const stripped = css.replace(/aspect-ratio\s*:\s*16\s*\/\s*9/gi, "");
  const strippedIssues = collectFlyerViolations(stripped).issues;
  assert(
    strippedIssues.some((i) => /aspect-ratio/.test(i)),
    "live CSS with 16/9 removed still passed the detector",
  );
  assert(
    !isSixteenByNine(resolveFlyerStyles(stripped, 1440).aspectRatio),
    "live CSS with 16/9 removed still cascaded as 16/9",
  );

  const mutated = css.replace(/aspect-ratio\s*:\s*16\s*\/\s*9/gi, "aspect-ratio: 4 / 3");
  const mutatedIssues = collectFlyerViolations(mutated).issues;
  assert(
    mutatedIssues.some((i) => /4\s*\/\s*3/.test(i)),
    "live CSS with 4/3 still passed the detector",
  );
  assert(
    !isSixteenByNine(resolveFlyerStyles(mutated, 375).aspectRatio),
    "live CSS mutated to 4/3 still cascaded as 16/9",
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

  const clampMatch = (cardWidth || "").match(/clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vw\s*,\s*([\d.]+)px\s*\)/);
  const padMatch = (cardPad || "").match(/^([\d.]+)px$/);
  if (clampMatch) {
    const spec = {
      min: Number(clampMatch[1]),
      vw: Number(clampMatch[2]) / 100,
      max: Number(clampMatch[3]),
      pad: padMatch ? Number(padMatch[1]) : 16,
    };
    for (const vw of ALL_VIEWPORTS) {
      const { mediaW } = flyerWidth(vw, spec);
      const resolved = resolveFlyerStyles(css, vw);
      assert(isSixteenByNine(resolved.aspectRatio), `live CSS at ${vw}px: parsed aspect-ratio ${resolved.aspectRatio}`);
      assert(mediaW > 0, `live CSS at ${vw}px: flyer width collapsed`);
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
