// Oracle: cloned events keep their public title and card date aligned with the
// real Otra Guide event, even while a new Cloudflare KV key is not listable.
// Run: node scripts/check-clone-date-card-sync.mjs

import fs from 'node:fs';
import { URL } from 'node:url';
import { projectDateLabel } from '../functions/_lib/homepage-feed.js';
import { rewriteProjectDate, syncSiteEventDates } from '../functions/admin/api/events.js';
import { cloneProjectTitle } from '../functions/admin/api/projects.js';

const adminHtml = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

function extractFunction(name, source) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  return '';
}

const parseDateSource = extractFunction('parseDateText', adminHtml);
const parseDateText = parseDateSource ? Function(`${parseDateSource}; return parseDateText;`)() : null;
assert(parseDateText, 'admin date parser must be available for behavior tests');
assert(parseDateText?.('Sunday Sept 6, 2026') === '2026-09-06', 'Sept abbreviation must update the real event');
assert(parseDateText?.('Sun, Sep 6th, 2026') === '2026-09-06', 'Sep abbreviation and ordinal must be accepted');
assert(parseDateText?.('December 13, 2026') === '2026-12-13', 'full month names must remain supported');

const september = {
  startDate: '2026-09-06T17:00:00-04:00',
  isPerennial: false,
  claudeDesign: {
    meta: ['Sun, July 5', '5PM to 8PM', 'Early Bird $95'],
    rates: [{ name: 'Early Bird', price: 95 }],
  },
};
assert(
  projectDateLabel(september) === 'Sun, September 6 · 5PM to 8PM',
  'card date must come from startDate while retaining the authored time'
);

const december = { ...september, startDate: '2026-12-13T17:00:00-04:00' };
assert(
  projectDateLabel(december) === 'Sun, December 13 · 5PM to 8PM',
  'a December event must not keep the source ZIP July date'
);

const noDateMeta = {
  startDate: '2026-09-06T17:00:00-04:00',
  claudeDesign: { meta: ['5PM to 8PM'], rates: [] },
};
assert(
  projectDateLabel(noDateMeta) === 'Sun, September 6 · 5PM to 8PM',
  'the actual date must be prepended when the design has only a time'
);

const rewritten = rewriteProjectDate(
  {
    otraGuideId: '7522',
    startDate: '2026-12-13T17:00:00-04:00',
    endDate: '2026-12-13T20:00:00-04:00',
    claudeDesign: { meta: ['Sunday Sept 6, 2026', 'Sun, July 5', '5PM to 8PM'] },
  },
  '2026-09-06T17:00:00-04:00',
  '2026-09-06T20:00:00-04:00'
);
assert(rewritten.startDate.startsWith('2026-09-06'), 'project startDate must follow the real event');
assert(rewritten.endDate.startsWith('2026-09-06'), 'project endDate must follow the real event');
assert(
  rewritten.claudeDesign.meta[0] === 'Sun, September 6, 2026' &&
    rewritten.claudeDesign.meta[1] === 'Sun, September 6, 2026',
  'full, abbreviated and yearless design dates must all be rewritten'
);

{
  const directKey = 'site-event:draft-new-bingo';
  const values = new Map([[directKey, {
    otraGuideId: '7522',
    startDate: '2026-12-13T17:00:00-04:00',
    endDate: '2026-12-13T20:00:00-04:00',
    claudeDesign: { meta: ['Sun, July 5', '5PM to 8PM'] },
  }]]);
  const puts = [];
  const kv = {
    async get(key) { return values.get(key) || null; },
    async put(key, value) { puts.push(key); values.set(key, JSON.parse(value)); },
    // Simulate Cloudflare's newly-created key not appearing in list() yet.
    async list() { return { keys: [], list_complete: true }; },
  };
  const count = await syncSiteEventDates(kv, {
    draftId: 'draft-new-bingo',
    eventId: 7522,
    newStartIso: '2026-09-06T17:00:00-04:00',
    newEndIso: '2026-09-06T20:00:00-04:00',
  });
  assert(count === 1, 'the exact new draft must be updated even when KV list() is empty');
  assert(puts.length === 1 && puts[0] === directKey, 'date sync must write the direct draft key once');
  assert(values.get(directKey).startDate.startsWith('2026-09-06'), 'direct draft date must be synchronized');
}

assert(cloneProjectTitle('Bingo Bengo', 'Bingo Bengo') === 'Bingo Bengo', 'requested clone title must not gain a suffix');
assert(
  cloneProjectTitle('Bingo Bengo', '') === 'Bingo Bengo (clone)',
  'older clients without a title must retain the safe clone suffix fallback'
);
assert(adminHtml.includes('id="cloneEventTitle"'), 'clone modal must expose an editable event title');
assert(
  /draftId:\s*data\.project\.id/.test(adminHtml),
  'clone date sync must send the exact freshly-created draft id'
);
assert(
  /title:\s*cloneTitle/.test(adminHtml),
  'clone request must send the public card title selected in the modal'
);

if (failures.length) {
  console.error('check-clone-date-card-sync FAILED:');
  failures.forEach((failure) => console.error(' - ' + failure));
  process.exit(1);
}

console.log('check-clone-date-card-sync OK (real card date, direct KV sync, editable clean clone title)');
