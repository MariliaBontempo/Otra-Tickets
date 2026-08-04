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

const addSource = extractFunction('addInfoCellFields');
const candidateSource = extractFunction('candidateElements');
const serializeSource = extractFunction('serializeInfoCellValue');
const parseSource = extractFunction('parseInfoCellValue');
const emptyValueSource = extractFunction('isEmptyInfoCellValue');
const deleteLegacySource = extractFunction('deleteLegacyInfoCellFields');
const storeSource = extractFunction('storeInfoCellFields');
const markupSource = extractFunction('infoCellMarkup', eventHtml);

assert(addSource, 'addInfoCellFields must exist');
assert(serializeSource, 'serializeInfoCellValue must exist');
assert(parseSource, 'parseInfoCellValue must exist');
assert(emptyValueSource, 'isEmptyInfoCellValue must exist');
assert(deleteLegacySource, 'deleteLegacyInfoCellFields must exist');
assert(storeSource, 'storeInfoCellFields must exist');
assert(markupSource, 'infoCellMarkup must exist in event.html');
assert(
  /\.ev-info-cell\.otra-empty-info-cell\s*\{\s*background:\s*var\(--ink\);\s*\}/.test(eventHtml),
  'empty info cells must default to the same black background as filled grid cells'
);
assert(
  !/\.ev-info-cell\.otra-empty-info-cell\s*\{[^}]*background:\s*transparent/.test(eventHtml),
  'empty info cells must never default to a transparent accent-colour block'
);
assert(
  /\.ev-info-cell \.v\s*\{[^}]*white-space:\s*pre-line/.test(eventHtml),
  'info-cell subtitles must visually preserve line breaks entered in the admin'
);
assert(
  candidateSource.includes('addInfoCellFields(doc, fields, seen)'),
  'candidateElements must include info cells before normal text discovery'
);

function makePart(className, text = '') {
  return {
    textContent: text,
    classList: { contains: (name) => name === className },
  };
}

function makeCell(titleText = '', subtitleText = '') {
  const title = titleText !== null ? makePart('k', titleText) : null;
  const subtitle = subtitleText !== null ? makePart('v', subtitleText) : null;
  return {
    textContent: [titleText, subtitleText].filter(Boolean).join(' '),
    classList: {
      contains(name) {
        return name === 'ev-info-cell';
      },
    },
    querySelector(selector) {
      if (selector === '.k') return title;
      if (selector === '.v') return subtitle;
      return null;
    },
  };
}

function discover(cell, savedField = null) {
  const fields = [];
  const seen = new Set();
  const main = {
    querySelectorAll(selector) {
      return selector === '.ev-info-cell' && cell.classList.contains('ev-info-cell') ? [cell] : [];
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
    parseInfoCellValue(value) {
      const prefix = 'otra-info-cell:';
      if (!String(value).startsWith(prefix)) return { title: '', subtitle: String(value || '') };
      return JSON.parse(String(value).slice(prefix.length));
    },
    infoCellValueFromElement(cellEl) {
      return {
        title: cellEl.querySelector('.k')?.textContent.trim() || '',
        subtitle: cellEl.querySelector('.v')?.textContent.trim() || '',
      };
    },
  };
  vm.runInNewContext(
    `${addSource}; this.run = addInfoCellFields;`,
    sandbox
  );
  sandbox.run(doc, fields, seen);
  return { fields, seen };
}

{
  const result = discover(makeCell(null, null));
  assert(result.fields.length === 1, 'an empty info cell must produce one editable field');
  assert(result.fields[0]?.type === 'text', 'the empty info cell field must open the text editor');
  assert(
    result.fields[0]?.key === 'text:main > section:nth-of-type(2) > div:nth-of-type(3)',
    'the empty info cell must use a stable text selector key'
  );
  assert(result.fields[0]?.host === result.fields[0]?.element, 'the pencil must be hosted by the visible cell');
  assert(result.fields[0]?.emptyInfoCell === true, 'the field must retain its empty-cell marker');
  assert(result.fields[0]?.storageKey === result.fields[0]?.key, 'the decorative pencil must store under the whole-cell key');
}

{
  const result = discover(makeCell('Meeting point', 'Cruise Terminal'));
  assert(result.fields.length === 2, 'a filled info cell must expose separate title and subtitle pencils');
  assert(result.fields[0]?.infoCellPart === 'title', 'the first pencil must edit only the title');
  assert(result.fields[1]?.infoCellPart === 'subtitle', 'the second pencil must edit only the subtitle');
  assert(result.fields[0]?.storageKey === result.fields[1]?.storageKey, 'both pencils must persist one coherent cell value');
  assert(result.fields[0]?.key.endsWith('::title'), 'the title pencil must have a unique preview key');
  assert(result.fields[1]?.key.endsWith('::subtitle'), 'the subtitle pencil must have a unique preview key');
}

{
  const saved = {
    type: 'text',
    value: 'otra-info-cell:{"title":"Added title","subtitle":"Added subtitle"}',
  };
  const result = discover(makeCell('Added title', 'Added subtitle'), saved);
  assert(result.fields.length === 2, 'a saved composite override must retain both independent pencils');
}

{
  const fake = {
    textContent: '',
    classList: { contains: () => false },
    querySelector: () => null,
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

if (serializeSource && deleteLegacySource && storeSource) {
  const sandbox = { INFO_CELL_VALUE_PREFIX: 'otra-info-cell:' };
  vm.runInNewContext(
    `${serializeSource}; ${deleteLegacySource}; ${storeSource}; this.store = storeInfoCellFields;`,
    sandbox
  );
  const key = 'text:#evInfoGrid > div:nth-of-type(11)';
  const fields = {
    [`${key} > div:nth-of-type(1)`]: { type: 'text', value: '' },
    [`${key} > div:nth-of-type(2)`]: { type: 'text', value: '' },
    'text:#evTitle': { type: 'text', value: 'Keep me' },
  };
  sandbox.store(fields, key, { title: '', subtitle: '' });
  assert(!fields[`${key} > div:nth-of-type(1)`], 'saving a cell must remove its legacy title override');
  assert(!fields[`${key} > div:nth-of-type(2)`], 'saving a cell must remove its legacy subtitle override');
  assert(fields['text:#evTitle']?.value === 'Keep me', 'saving a cell must preserve unrelated overrides');
  assert(
    fields[key]?.value === 'otra-info-cell:{"title":"","subtitle":""}',
    'clearing both parts must store an explicit empty marker so template text cannot reappear'
  );

  sandbox.store(fields, key, { title: 'Meeting point', subtitle: 'Cruise Terminal' });
  assert(
    fields[key]?.value === 'otra-info-cell:{"title":"Meeting point","subtitle":"Cruise Terminal"}',
    'title and subtitle pencils must persist one coherent composite value'
  );
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

  const multiline = sandbox.render([['Tickets', 'Early Bird $20 · limited\nDay Of $30']]);
  assert(
    multiline.includes('Early Bird $20 · limited\nDay Of $30'),
    'info-cell markup must preserve the authored newline for CSS to render'
  );
}

if (failures.length) {
  console.error('check-admin-empty-info-cell FAILED:');
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}

console.log('check-admin-empty-info-cell OK (empty discovery, filled guard, saved-field re-edit)');
