// Oracle: a decorative, textless .ev-info-cell must receive one editable text
// field in the admin preview, and a saved override must remain editable after
// the public renderer has turned it into visible text.
// Run: node scripts/check-admin-empty-info-cell.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function extractFunction(name) {
  const start = html.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = html.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  return '';
}

const addSource = extractFunction('addEmptyInfoCellFields');
const emptySource = extractFunction('isEmptyInfoCell');
const candidateSource = extractFunction('candidateElements');
const serializeSource = extractFunction('serializeInfoCellValue');
const parseSource = extractFunction('parseInfoCellValue');

assert(addSource, 'addEmptyInfoCellFields must exist');
assert(emptySource, 'isEmptyInfoCell must exist');
assert(serializeSource, 'serializeInfoCellValue must exist');
assert(parseSource, 'parseInfoCellValue must exist');
assert(
  candidateSource.includes('addEmptyInfoCellFields(doc, fields, seen)'),
  'candidateElements must include empty info cells before normal text discovery'
);

function makeCell(text = '') {
  return {
    textContent: text,
    classList: {
      contains(name) {
        return name === 'ev-info-cell';
      },
    },
  };
}

function discover(cell, savedField = null) {
  const fields = [];
  const seen = new Set();
  const main = {
    querySelectorAll(selector) {
      return selector === '.ev-info-cell' ? [cell] : [];
    },
  };
  const doc = {
    body: main,
    querySelector(selector) {
      return selector === 'main' ? main : null;
    },
  };
  const sandbox = {
    selectorFor: () => 'main > section:nth-of-type(2) > div:nth-of-type(3)',
    fieldOverrideForKey: () => savedField,
  };
  vm.runInNewContext(
    `${emptySource}; ${addSource}; this.run = addEmptyInfoCellFields;`,
    sandbox
  );
  sandbox.run(doc, fields, seen);
  return { fields, seen };
}

{
  const result = discover(makeCell(''));
  assert(result.fields.length === 1, 'an empty info cell must produce one editable field');
  assert(result.fields[0]?.type === 'text', 'the empty info cell field must open the text editor');
  assert(
    result.fields[0]?.key === 'text:main > section:nth-of-type(2) > div:nth-of-type(3)',
    'the empty info cell must use a stable text selector key'
  );
  assert(result.fields[0]?.host === result.fields[0]?.element, 'the pencil must be hosted by the visible cell');
  assert(result.fields[0]?.emptyInfoCell === true, 'the field must retain its empty-cell marker');
}

{
  const result = discover(makeCell('Existing information'));
  assert(result.fields.length === 0, 'a normal filled info cell must keep using its existing .k/.v editors');
}

{
  const saved = { type: 'text', value: 'Added through the admin' };
  const result = discover(makeCell('Added through the admin'), saved);
  assert(result.fields.length === 1, 'a saved whole-cell override must remain editable after rendering');
}

{
  const fake = {
    textContent: '',
    classList: { contains: () => false },
  };
  const result = discover(fake);
  assert(result.fields.length === 0, 'an unrelated empty element must not become an info-cell editor');
}

if (serializeSource && parseSource) {
  const sandbox = { INFO_CELL_VALUE_PREFIX: 'otra-info-cell:' };
  vm.runInNewContext(
    `${serializeSource}; ${parseSource}; this.serialize = serializeInfoCellValue; this.parse = parseInfoCellValue;`,
    sandbox
  );
  const encoded = sandbox.serialize(' Meeting point ', ' Curaçao Cruise Terminal ');
  const decoded = sandbox.parse(encoded);
  assert(decoded.title === 'Meeting point', 'info-cell title must round-trip through storage');
  assert(decoded.subtitle === 'Curaçao Cruise Terminal', 'info-cell subtitle must round-trip through storage');

  const legacy = sandbox.parse('Legacy subtitle only');
  assert(legacy.title === '', 'legacy single-value override must not invent a title');
  assert(legacy.subtitle === 'Legacy subtitle only', 'legacy single-value override must remain as subtitle');
}

if (failures.length) {
  console.error('check-admin-empty-info-cell FAILED:');
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}

console.log('check-admin-empty-info-cell OK (empty discovery, filled guard, saved-field re-edit)');
