// Oracle: a decorative, textless .ev-info-cell must receive one editable text
// field in the admin preview, and a saved override must remain editable after
// the public renderer has turned it into visible text.
// Run: node scripts/check-admin-empty-info-cell.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const eventHtml = fs.readFileSync(new URL('../event.html', import.meta.url), 'utf8');
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function extractFunction(name, source = html) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

const addSource = extractFunction('addEmptyInfoCellFields');
const emptySource = extractFunction('isEmptyInfoCell');
const candidateSource = extractFunction('candidateElements');
const serializeSource = extractFunction('serializeInfoCellValue');
const parseSource = extractFunction('parseInfoCellValue');
const emptyValueSource = extractFunction('isEmptyInfoCellValue');
const markupSource = extractFunction('infoCellMarkup', eventHtml);

assert(addSource, 'addEmptyInfoCellFields must exist');
assert(emptySource, 'isEmptyInfoCell must exist');
assert(serializeSource, 'serializeInfoCellValue must exist');
assert(parseSource, 'parseInfoCellValue must exist');
assert(emptyValueSource, 'isEmptyInfoCellValue must exist');
assert(markupSource, 'infoCellMarkup must exist in event.html');
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

if (serializeSource && parseSource && emptyValueSource) {
  const sandbox = { INFO_CELL_VALUE_PREFIX: 'otra-info-cell:' };
  vm.runInNewContext(
    `${serializeSource}; ${parseSource}; ${emptyValueSource}; this.serialize = serializeInfoCellValue; this.parse = parseInfoCellValue; this.isEmpty = isEmptyInfoCellValue;`,
    sandbox
  );
  const encoded = sandbox.serialize(' Meeting point ', ' Curaçao Cruise Terminal ');
  const decoded = sandbox.parse(encoded);
  assert(decoded.title === 'Meeting point', 'info-cell title must round-trip through storage');
  assert(decoded.subtitle === 'Curaçao Cruise Terminal', 'info-cell subtitle must round-trip through storage');

  const legacy = sandbox.parse('Legacy subtitle only');
  assert(legacy.title === '', 'legacy single-value override must not invent a title');
  assert(legacy.subtitle === 'Legacy subtitle only', 'legacy single-value override must remain as subtitle');
  assert(sandbox.isEmpty(sandbox.serialize('', '')) === true, 'two cleared inputs must remove the info-cell override');
  assert(sandbox.isEmpty(sandbox.serialize('Title', '')) === false, 'a remaining title must keep the override');
  assert(sandbox.isEmpty(sandbox.serialize('', 'Subtitle')) === false, 'a remaining subtitle must keep the override');
}

if (markupSource) {
  const sandbox = {
    esc: (value) => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;'),
  };
  vm.runInNewContext(`${markupSource}; this.render = infoCellMarkup;`, sandbox);

  const ten = Array.from({ length: 10 }, (_, index) => [`Title ${index + 1}`, `Value ${index + 1}`]);
  const tenMarkup = sandbox.render(ten);
  assert(
    (tenMarkup.match(/class="ev-info-cell/g) || []).length === 12,
    'a 10-cell three-column grid must render two real empty cells'
  );
  assert(
    (tenMarkup.match(/otra-empty-info-cell/g) || []).length === 2,
    'Clearboat West Coast shape must expose two editable placeholders'
  );

  const nine = Array.from({ length: 9 }, (_, index) => [`Title ${index + 1}`, `Value ${index + 1}`]);
  assert(
    !sandbox.render(nine).includes('otra-empty-info-cell'),
    'a complete grid row must not gain placeholder cells'
  );
  assert(sandbox.render([]) === '', 'an empty info section must not render an entire placeholder row');
}

if (failures.length) {
  console.error('check-admin-empty-info-cell FAILED:');
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}

console.log('check-admin-empty-info-cell OK (empty discovery, filled guard, saved-field re-edit)');
