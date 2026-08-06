#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

// --root <dir> redirects reads of the four contract files; package.json always uses repoRoot
let contractRoot = repoRoot;
const rootIdx = process.argv.indexOf('--root');
if (rootIdx !== -1 && process.argv[rootIdx + 1]) {
  contractRoot = process.argv[rootIdx + 1];
}

function fail(file, reason) {
  failures.push(`FAIL ${file}: ${reason}`);
}

function read(filePath) {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8');
}

function normalizeApostrophes(text) {
  return text
    .replace(/’/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#x2019;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '');
}

// --- package.json: required script entries (always repoRoot) ---
const pkgRaw = read(join(repoRoot, 'package.json'));
if (!pkgRaw) {
  fail('package.json', 'file missing');
} else {
  let pkg = null;
  try { pkg = JSON.parse(pkgRaw); } catch { fail('package.json', 'invalid JSON'); }
  if (pkg) {
    const scripts = pkg.scripts || {};
    for (const s of ['build', 'gen:variants', 'check:headers', 'check:fonts', 'check:seo', 'check:payload', 'check:admin-only', 'check:ux']) {
      if (!scripts[s]) fail('package.json', `missing script: ${s}`);
    }
  }
}

// --- Read contract files from contractRoot ---
const indexRaw = read(join(contractRoot, 'index.html'));
const eventRaw = read(join(contractRoot, 'event.html'));
const overridesRaw = read(join(contractRoot, 'site-overrides.js'));
const clearboatRaw = read(join(contractRoot, 'clearboat.html'));
const rnbRaw = read(join(contractRoot, 'rnb.html'));

if (!indexRaw) fail('index.html', 'file missing');
if (!eventRaw) fail('event.html', 'file missing');
if (!overridesRaw) fail('site-overrides.js', 'file missing');
if (!clearboatRaw) fail('clearboat.html', 'file missing');
if (!rnbRaw) fail('rnb.html', 'file missing');

// Event detail pages intentionally expose only the primary booking action in
// the title block. The story follows directly below, so a secondary "Read
// more" button must not be reintroduced by static or generic templates.
for (const [file, raw] of [
  ['event.html', eventRaw],
  ['clearboat.html', clearboatRaw],
  ['rnb.html', rnbRaw],
]) {
  if (raw && /<a[^>]+href=["']#story["'][^>]*>\s*Read more\s*<\/a>/i.test(raw)) {
    fail(file, 'event detail title block must not include a Read more button');
  }
}

// --- index.html copy contract (full file, apostrophes normalized) ---
if (indexRaw) {
  const norm = normalizeApostrophes(indexRaw);
  for (const s of [
    "We couldn't load events.",
    "Check your connection and try again.",
    "Try again",
    "No upcoming events right now.",
    "New events are added all the time - check back soon.",
    "Still loading events - hang tight.",
  ]) {
    if (!norm.includes(s)) fail('index.html', `missing copy: "${s}"`);
  }
}

// --- event.html copy contract (full file, apostrophes normalized) ---
if (eventRaw) {
  const norm = normalizeApostrophes(eventRaw);
  for (const s of [
    "We couldn't load this event.",
    "It may have ended, or the link may be out of date.",
    "Browse all events",
    "Tickets aren't on sale yet.",
    "Check back soon, or ",
    "explore other events",
  ]) {
    if (!norm.includes(s)) fail('event.html', `missing copy: "${s}"`);
  }
}

// --- index.html skeleton contract (script-stripped static markup) ---
if (indexRaw) {
  const staticMarkup = stripScripts(indexRaw);
  for (const token of ['id="rows-skeleton"', 'class="card-img sk-shimmer"', 'sk-line sk-head', 'sk-line sk-title']) {
    if (!staticMarkup.includes(token)) fail('index.html', `missing skeleton token: ${token}`);
  }
  if (!indexRaw.includes('prefers-reduced-motion')) {
    fail('index.html', 'missing prefers-reduced-motion');
  }
}

// --- event.html skeleton contract (script-stripped static markup) ---
if (eventRaw) {
  const staticMarkup = stripScripts(eventRaw);
  for (const token of ['data-skeleton', 'sk-hero', 'sk-title-group', 'id="evTicketsSkeleton"', 'sk-tickets']) {
    if (!staticMarkup.includes(token)) fail('event.html', `missing skeleton token: ${token}`);
  }
  if (!eventRaw.includes('prefers-reduced-motion')) {
    fail('event.html', 'missing prefers-reduced-motion');
  }
}

// --- CLS protection: skeleton CSS declares reserved dimensions ---
if (indexRaw) {
  // .card-img (used by skeleton cards as class="card-img sk-shimmer") must reserve dimensions
  if (!indexRaw.includes('aspect-ratio: 16 / 9')) {
    fail('index.html', 'CLS: missing aspect-ratio: 16 / 9 in skeleton card CSS (.card-img)');
  }
  if (!indexRaw.includes('width: 100%')) {
    fail('index.html', 'CLS: missing width: 100% in skeleton card CSS (.card-img)');
  }
}

if (eventRaw) {
  // .ev-hero wraps .sk-hero skeleton and must reserve aspect-ratio
  if (!eventRaw.includes('aspect-ratio: 16 / 9')) {
    fail('event.html', 'CLS: missing aspect-ratio: 16 / 9 in hero skeleton container CSS (.ev-hero)');
  }
  // .sk-ticket must declare a minimum height
  if (!eventRaw.includes('min-height: 120px')) {
    fail('event.html', 'CLS: missing min-height: 120px in .sk-ticket CSS');
  }
}

// --- Guard contract: site-overrides.js ---
if (overridesRaw) {
  // decode-before-paint signal
  if (!(/\.decode\s*\(/.test(overridesRaw) || /new Image\s*\(/.test(overridesRaw))) {
    fail('site-overrides.js', 'missing decode-before-paint signal (.decode( or new Image()');
  }
  // compare-before-set guards
  if (!overridesRaw.includes('el.textContent !== value')) {
    fail('site-overrides.js', 'missing textContent compare-before-set guard');
  }
  if (!overridesRaw.includes('el.src !== abs')) {
    fail('site-overrides.js', 'missing .src compare-before-set guard');
  }
  if (!overridesRaw.includes('el.style.backgroundImage !== bg')) {
    fail('site-overrides.js', 'missing backgroundImage compare-before-set guard');
  }
  // pending/unapplied-key tracking Set (PRD 04 introduced "applied" parameter)
  if (!overridesRaw.includes('applied = new Set()')) {
    fail('site-overrides.js', 'missing pending-key tracking: applied = new Set()');
  }
  // retry is gated on pending check
  if (!overridesRaw.includes('remaining.length > 0 && attempt < 30')) {
    fail('site-overrides.js', 'missing retry guard: remaining.length > 0 && attempt < 30');
  }
}

// --- Guard contract: clearboat.html accent sync ---
if (clearboatRaw) {
  const scriptBlocks = clearboatRaw.match(/<script[\s\S]*?<\/script>/gi) || [];
  const accentBlock = scriptBlocks.find((b) => b.includes('/api/event?id=6113'));
  if (!accentBlock) {
    fail('clearboat.html', 'missing inline script block containing /api/event?id=6113');
  } else {
    if (!accentBlock.includes('setProperty("--accent"')) {
      fail('clearboat.html', 'accent sync block missing setProperty("--accent"');
    }
    if (!accentBlock.includes('getPropertyValue')) {
      fail('clearboat.html', 'accent sync block missing differs-from-current guard (getPropertyValue)');
    }
  }
}

// --- Output ---
if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}

console.log('check-ux-states OK');
