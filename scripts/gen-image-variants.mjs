#!/usr/bin/env node
/**
 * gen-image-variants.mjs
 * Emit width-variant AVIF + WebP sets into uploads/variants/ using on-PATH
 * binaries: cwebp, avifenc, magick, sips. Zero npm dependencies.
 *
 * Usage:
 *   node scripts/gen-image-variants.mjs <input...> [options]
 *
 * Options:
 *   --widths   400,800,1200   Comma-separated target widths in px
 *   --formats  avif,webp      Comma-separated output formats
 *   --out      uploads/variants  Output directory
 *   --quality  80             Encoder quality (0-100)
 *   --force                   Re-encode even if output already exists
 *   --dry-run                 Log planned outputs, write nothing
 *   --name     BASENAME       Override derived basename for output filenames
 *   -h, --help                Print this help and exit
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `
Usage: node scripts/gen-image-variants.mjs <input...> [options]

Generate responsive AVIF + WebP width variants alongside originals.
Originals are NEVER modified. Variants land in --out (default: uploads/variants).

Options:
  --widths   <w1,w2,...>   Target widths in px (default: 400,800,1200)
  --formats  <f1,f2,...>   Output formats: avif, webp (default: avif,webp)
  --out      <dir>         Output directory (default: uploads/variants)
  --quality  <n>           Encoder quality 0-100 (default: 80)
  --force                  Re-encode even if output already exists
  --dry-run                Log planned outputs, write nothing
  --name     <BASENAME>    Override derived basename for output filenames
  -h, --help               Print this help and exit

Output filename pattern: <out>/<basename-without-ext>-<width>.<format>
Example: uploads/R2C5.webp --widths 800 -> uploads/variants/R2C5-800.avif
`.trim();

function help() {
  console.log(HELP);
  process.exit(0);
}

// Parse CLI
let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      widths:   { type: 'string',  default: '400,800,1200' },
      formats:  { type: 'string',  default: 'avif,webp' },
      out:      { type: 'string',  default: 'uploads/variants' },
      quality:  { type: 'string',  default: '80' },
      force:    { type: 'boolean', default: false },
      'dry-run':{ type: 'boolean', default: false },
      name:     { type: 'string',  default: '' },
      help:     { type: 'boolean', default: false, short: 'h' },
    },
  }));
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}

if (values.help) help();
if (positionals.length === 0) {
  console.error('Error: at least one input file is required.');
  console.error('Run with --help for usage.');
  process.exit(1);
}

const requestedWidths  = values.widths.split(',').map(w => parseInt(w.trim(), 10)).filter(Boolean);
const requestedFormats = values.formats.split(',').map(f => f.trim().toLowerCase()).filter(Boolean);
const outDir           = resolve(values.out);
const quality          = parseInt(values.quality, 10);
const force            = values.force;
const dryRun           = values['dry-run'];
const nameOverride     = values.name;

if (!dryRun) {
  mkdirSync(outDir, { recursive: true });
}

// Read source pixel width
function sourceWidth(inputPath) {
  const r = spawnSync('sips', ['-g', 'pixelWidth', inputPath], { encoding: 'utf8' });
  if (r.status === 0) {
    const m = r.stdout.match(/pixelWidth:\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  // fallback to magick
  const r2 = spawnSync('magick', ['identify', '-format', '%w', inputPath], { encoding: 'utf8' });
  if (r2.status === 0 && r2.stdout.trim()) return parseInt(r2.stdout.trim(), 10);
  throw new Error(`Cannot determine width of ${inputPath}`);
}

// Encode WebP variant
function encodeWebp(input, output, width, q) {
  const r = spawnSync(
    'cwebp',
    ['-q', String(q), '-resize', String(width), '0', input, '-o', output],
    { stdio: 'inherit' },
  );
  return r.status;
}

// Encode AVIF variant using magick (handles webp input directly)
function encodeAvif(input, output, width, q) {
  const r = spawnSync(
    'magick',
    [input, '-resize', `${width}x`, '-quality', String(q), output],
    { stdio: 'inherit' },
  );
  return r.status;
}

// Load existing manifest or start fresh
const manifestPath = resolve(outDir, 'manifest.json');
let manifest = {};
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = {};
  }
}

let anyFailure = false;

for (const inputRel of positionals) {
  const inputPath = resolve(inputRel);

  if (!existsSync(inputPath)) {
    console.error(`Error: input not found: ${inputPath}`);
    anyFailure = true;
    continue;
  }

  let srcWidth;
  try {
    srcWidth = sourceWidth(inputPath);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    anyFailure = true;
    continue;
  }

  const ext      = extname(inputPath);
  const base     = nameOverride || basename(inputPath, ext);
  const srcKey   = basename(inputPath);

  if (!manifest[srcKey]) manifest[srcKey] = [];

  for (const width of requestedWidths) {
    if (width >= srcWidth) {
      console.log(`skip  ${base}-${width}.* — requested width ${width} >= source ${srcWidth}`);
      continue;
    }

    for (const fmt of requestedFormats) {
      const outFile = resolve(outDir, `${base}-${width}.${fmt}`);
      const relOut  = `${values.out}/${base}-${width}.${fmt}`;

      if (!force && existsSync(outFile)) {
        console.log(`skip  ${relOut} (exists; use --force to regenerate)`);
        continue;
      }

      if (dryRun) {
        console.log(`plan  ${relOut} [${width}px ${fmt} q=${quality}]`);
        continue;
      }

      console.log(`gen   ${relOut} [${width}px ${fmt} q=${quality}]`);

      let status;
      if (fmt === 'webp') {
        status = encodeWebp(inputPath, outFile, width, quality);
      } else if (fmt === 'avif') {
        status = encodeAvif(inputPath, outFile, width, quality);
      } else {
        console.error(`Error: unsupported format "${fmt}"`);
        anyFailure = true;
        continue;
      }

      if (status !== 0) {
        console.error(`Error: encoder exited ${status} for ${relOut}`);
        anyFailure = true;
        continue;
      }

      const bytes = statSync(outFile).size;
      // Merge into manifest: replace existing entry for same path or add new
      const entry = { path: relOut, width, format: fmt, bytes };
      const idx = manifest[srcKey].findIndex(e => e.path === relOut);
      if (idx >= 0) {
        manifest[srcKey][idx] = entry;
      } else {
        manifest[srcKey].push(entry);
      }
    }
  }
}

if (!dryRun) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest -> ${manifestPath}`);
}

process.exit(anyFailure ? 1 : 0);
