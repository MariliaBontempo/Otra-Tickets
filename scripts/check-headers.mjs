import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const headersPath = join(root, "_headers");
const buildScriptPath = join(root, "scripts", "build-pages.mjs");

const failures = [];

function fail(reason) {
  failures.push(reason);
}

// 1. Stat the _headers file; fail if missing or empty.
let headersText;
try {
  const stat = statSync(headersPath);
  if (stat.size === 0) fail("_headers exists but is empty");
  headersText = readFileSync(headersPath, "utf8");
} catch {
  fail("_headers file is missing at repo root");
}

// Parse _headers into blocks.
// Each block: { path: string, headers: Map<lowercaseName, trimmedValue> }
const blocks = [];
let currentBlock = null;
const lines = (headersText || "").split("\n");

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const lineNum = i + 1;

  // Skip blank lines and comments.
  if (raw.trim() === "" || raw.trim().startsWith("#")) continue;

  if (/^[/]|^https?:\/\//.test(raw)) {
    // Path line.
    currentBlock = { path: raw.trim(), headers: new Map() };
    blocks.push(currentBlock);
  } else if (/^\s+[A-Za-z0-9-]+:\s*.+/.test(raw)) {
    // Header line.
    if (!currentBlock) {
      fail(`Line ${lineNum}: header line before any path line: ${raw}`);
      continue;
    }
    const colonIdx = raw.indexOf(":");
    const name = raw.slice(0, colonIdx).trim().toLowerCase();
    const value = raw.slice(colonIdx + 1).trim();
    currentBlock.headers.set(name, value);
  } else {
    fail(`Line ${lineNum}: malformed line (not a path, header, comment, or blank): ${raw}`);
  }
}

// 2. Check immutable asset paths.
const immutablePaths = ["/uploads/*", "/photos/*", "/fonts/*"];
for (const p of immutablePaths) {
  const block = blocks.find((b) => b.path === p);
  if (!block) {
    fail(`Missing path rule for ${p}`);
    continue;
  }
  const cc = block.headers.get("cache-control");
  if (!cc) {
    fail(`${p} has no Cache-Control header`);
  } else if (cc !== "public, max-age=31536000, immutable") {
    fail(`${p} Cache-Control value is "${cc}", expected "public, max-age=31536000, immutable"`);
  }
}

// 3. Check HTML rule.
const htmlPaths = ["/*.html", "/"];
const htmlBlock = blocks.find((b) => htmlPaths.includes(b.path));
if (!htmlBlock) {
  fail('No HTML path rule found (expected "/*.html" or "/")');
} else {
  const cc = htmlBlock.headers.get("cache-control") || "";
  const maxAgeMatch = cc.match(/max-age=(\d+)/i);
  if (!maxAgeMatch) {
    fail(`HTML rule (${htmlBlock.path}) Cache-Control has no max-age directive: "${cc}"`);
  } else if (parseInt(maxAgeMatch[1], 10) > 3600) {
    fail(`HTML rule (${htmlBlock.path}) Cache-Control max-age ${maxAgeMatch[1]} exceeds 3600`);
  }
  if (/\bimmutable\b/i.test(cc)) {
    fail(`HTML rule (${htmlBlock.path}) Cache-Control must not contain "immutable": "${cc}"`);
  }
}

// 4. No /api path lines.
for (const block of blocks) {
  if (/^\/api/i.test(block.path)) {
    fail(`_headers must not have an /api rule; found: ${block.path}`);
  }
}

// 5. No catch-all /* with immutable.
for (const block of blocks) {
  if (block.path === "/*") {
    const cc = block.headers.get("cache-control") || "";
    if (/\bimmutable\b/i.test(cc)) {
      fail(`_headers must not have a /* rule with immutable; found: ${block.path} Cache-Control: ${cc}`);
    }
  }
}

// 6. build-pages.mjs references "_headers".
try {
  const buildText = readFileSync(buildScriptPath, "utf8");
  if (!buildText.includes('"_headers"')) {
    fail('scripts/build-pages.mjs does not contain "_headers" in copyEntries');
  }
} catch {
  fail("scripts/build-pages.mjs not found");
}

if (failures.length > 0) {
  for (const reason of failures) console.error("FAIL:", reason);
  process.exit(1);
}

console.log("HEADERS: OK");
process.exit(0);
