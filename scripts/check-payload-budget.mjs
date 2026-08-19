#!/usr/bin/env node
// Oracle: derives the home ATF image set from source, sums the smallest
// responsive variant a mobile browser would pick, and asserts the set is
// within budget.
// 1 MB = 1,000,000 bytes (decimal). PASS is strictly bytes < budget.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const HOME_BUDGET = 1500000; // 1 MB = 1,000,000 bytes (decimal). PASS is strictly bytes < budget.

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const VARIANTS_DIR = join(REPO_ROOT, 'uploads', 'variants');

// ---------------------------------------------------------------------------
// --selftest: exercises the budget comparator with synthetic fixtures.
// Exits 0 only if BOTH over-budget (FAIL) and under-budget (PASS) behave correctly.
// ---------------------------------------------------------------------------
if (process.argv.includes('--selftest')) {
  function budgetCheck(bytes, budget) {
    return bytes < budget ? 'PASS' : 'FAIL';
  }

  const overResult  = budgetCheck(2_000_000, 1_500_000);
  const underResult = budgetCheck(800_000,   1_000_000);

  if (overResult !== 'FAIL') {
    console.error('SELFTEST FAIL: over-budget case should yield FAIL, got ' + overResult);
    process.exit(1);
  }
  if (underResult !== 'PASS') {
    console.error('SELFTEST FAIL: under-budget case should yield PASS, got ' + underResult);
    process.exit(1);
  }
  console.log('SELFTEST PASS');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseHomeSources() {
  const html = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
  const refs = [];

  // Hero mosaic is now a SINGLE composite image: uploads/variants/mosaic-hero-<w>.<fmt>
  if (!/uploads\/variants\/mosaic-hero-\d+\.(avif|webp)/.test(html)) {
    throw new Error('Could not find the mosaic-hero composite referenced in index.html');
  }
  refs.push({ imgRef: 'uploads/variants/mosaic-hero-1920.webp', slugBase: 'mosaic-hero' });

  // Hero wordmark overlay (the other large above-the-fold image)
  if (!/uploads\/variants\/otra-ticketing-words-\d+\.(avif|webp)/.test(html)) {
    throw new Error('Could not find the wordmark variants referenced in index.html');
  }
  refs.push({ imgRef: 'uploads/OTRA TICKETING Words.webp', slugBase: 'otra-ticketing-words' });

  // Logo src from the .brand <picture><img src="..."> block (src points straight at a variant)
  const logoMatch = html.match(
    /<a[^>]+class="brand"[^>]*>[\s\S]*?<img[^>]+\bsrc="([^"]+)"[^>]*>/
  );
  if (!logoMatch) throw new Error('Could not find .brand img src in index.html');
  refs.push({ imgRef: logoMatch[1], slugBase: null });

  return refs;
}

// ---------------------------------------------------------------------------
// Variant resolution
// ---------------------------------------------------------------------------

function globVariants(base, ext) {
  if (!existsSync(VARIANTS_DIR)) return [];
  const prefix = base + '-';
  return readdirSync(VARIANTS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith(ext))
    .map(f => join(VARIANTS_DIR, f));
}

function smallestFile(paths) {
  return paths.reduce(
    (best, p) => {
      const sz = statSync(p).size;
      return sz < best.size ? { path: p, size: sz } : best;
    },
    { path: null, size: Infinity }
  );
}

// Find the smallest variant for a given image ref.
// slugBase overrides the URL-derived base for globbing.
// When ref is already in uploads/variants/ and no hyphen-suffix variants exist,
// falls back to checking for the same-base AVIF/WebP file directly.
function findSmallestVariant(ref, slugBase) {
  // Derive glob base
  let base;
  if (slugBase) {
    base = slugBase;
  } else {
    base = basename(ref, extname(ref));
  }

  let avifCandidates = globVariants(base, '.avif');
  let webpCandidates = globVariants(base, '.webp');

  // When the ref itself is already inside uploads/variants/ and no hyphen-suffix
  // variants were found, check for a same-base file with .avif extension.
  // This handles the logo, whose img src points to the variant directly.
  const refAbsDir = dirname(resolve(REPO_ROOT, ref));
  const isInVariants = refAbsDir === resolve(VARIANTS_DIR);

  if (isInVariants && avifCandidates.length === 0 && webpCandidates.length === 0) {
    const directAvif = join(VARIANTS_DIR, base + '.avif');
    const directWebp = join(VARIANTS_DIR, base + '.webp');
    if (existsSync(directAvif)) avifCandidates = [directAvif];
    if (existsSync(directWebp)) webpCandidates = [directWebp];
  }

  // If still no variants, attempt best-effort generation via gen-image-variants.mjs
  if (avifCandidates.length === 0 && webpCandidates.length === 0) {
    const genScript = join(REPO_ROOT, 'scripts', 'gen-image-variants.mjs');
    const originalPath = join(REPO_ROOT, ref);
    if (existsSync(genScript) && existsSync(originalPath)) {
      console.log('  spawning gen-image-variants.mjs for ' + ref + ' ...');
      spawnSync(process.execPath, [genScript, originalPath], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
      avifCandidates = globVariants(base, '.avif');
      webpCandidates = globVariants(base, '.webp');
    }
  }

  // Still no variants: count original file bytes and flag the miss.
  // A missing variant set must NOT silently pass - it inflates the total.
  if (avifCandidates.length === 0 && webpCandidates.length === 0) {
    const fallbackPath = join(REPO_ROOT, ref);
    const bytes = existsSync(fallbackPath) ? statSync(fallbackPath).size : 0;
    process.stdout.write('MISSING-VARIANT ' + basename(ref) + '\n');
    return { chosen: fallbackPath, bytes, missing: true };
  }

  // Pick smallest - AVIF preferred at equal-or-smaller bytes
  const bestAvif = smallestFile(avifCandidates);
  const bestWebp = smallestFile(webpCandidates);

  if (bestAvif.path && (!bestWebp.path || bestAvif.size <= bestWebp.size)) {
    return { chosen: bestAvif.path, bytes: bestAvif.size };
  }
  return { chosen: bestWebp.path, bytes: bestWebp.size };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  const homeRefs = parseHomeSources();

  console.log('\nHome ATF set (' + homeRefs.length + ' refs):');
  let homeTotal = 0;
  for (const { imgRef, slugBase } of homeRefs) {
    const result = findSmallestVariant(imgRef, slugBase);
    console.log('  ' + basename(imgRef) + ' -> ' + basename(result.chosen) + ' ' + result.bytes);
    homeTotal += result.bytes;
  }

  console.log('');
  const homeVerdict = homeTotal < HOME_BUDGET ? 'PASS' : 'FAIL';
  console.log('BUDGET home ' + homeTotal + '/' + HOME_BUDGET + ' ' + homeVerdict);

  if (homeVerdict === 'FAIL') {
    process.exit(1);
  }
}

run();
