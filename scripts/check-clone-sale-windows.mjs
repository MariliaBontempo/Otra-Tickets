// Oracle: cloning forces confirmation of ticket sale start and end dates.
// Run: node scripts/check-clone-sale-windows.mjs

import fs from 'node:fs';
import { URL } from 'node:url';
import {
  buildCloneSaleWindowsFromSource,
  cloneSaleWindowWarnings,
  curacaoDayFromValue,
  dayToSaleEndIso,
  dayToSaleStartIso,
  normalizeCloneSaleWindow,
  normalizeCloneSaleWindows,
  shiftCloneEventDay,
  toCuracaoOffsetIso,
  toDay,
} from '../functions/_lib/clone-sale-windows.js';

const adminHtml = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const projectsJs = fs.readFileSync(new URL('../functions/admin/api/projects.js', import.meta.url), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

assert(toDay('2026-09-20T12:00:00-04:00') === '2026-09-20', 'ISO timestamps must reduce to YYYY-MM-DD');
assert(dayToSaleStartIso('2026-09-20') === '2026-09-20T00:00:00-04:00', 'sale start must use Curacao midnight');
assert(dayToSaleEndIso('2026-09-20') === '2026-09-20T23:59:59-04:00', 'sale end must use Curacao end of day');

const fromClosedSource = buildCloneSaleWindowsFromSource(
  [
    {
      id: 1,
      name: 'Early Bird',
      saleStartDate: '2026-07-01T00:00:00-04:00',
      saleEndDate: '2026-08-01T23:59:59-04:00',
      isActive: true,
    },
    {
      id: 2,
      name: 'General Admission',
      saleStartDate: '2026-08-02T00:00:00-04:00',
      saleEndDate: '2026-08-10T12:00:00-04:00',
      isActive: false,
    },
  ],
  [{ name: 'Early Bird' }, { name: 'General Admission' }],
  { today: '2026-09-03', eventDate: '2026-09-20' }
);
assert(fromClosedSource.length === 2, 'source tickets must seed one confirmation row each');
assert(fromClosedSource[0].saleStartDate === '2026-07-01', 'Early Bird sale start must be copied for review');
assert(fromClosedSource[0].saleEndDate === '2026-08-01', 'Early Bird sale end must be copied for review');
assert(fromClosedSource[1].isActive === false, 'inactive GA must remain visible in the confirmation step');

const warnings = cloneSaleWindowWarnings(fromClosedSource, { today: '2026-09-03' });
assert(warnings.some((note) => /Early Bird/.test(note)), 'past Early Bird end must warn');
assert(warnings.some((note) => /General Admission/.test(note)), 'inactive GA must warn');

let missingError = '';
try {
  normalizeCloneSaleWindows([]);
} catch (error) {
  missingError = error.message;
}
assert(/confirm ticket sale/i.test(missingError), 'empty confirmation must fail closed by default');
assert(normalizeCloneSaleWindows([], { allowEmpty: true }).length === 0, 'explicit empty confirmation is allowed when there are no tickets');
let countError = '';
try {
  normalizeCloneSaleWindows([], { expectedCount: 2 });
} catch (error) {
  countError = error.message;
}
assert(/all 2 ticket types/i.test(countError), 'window count must match expected ticket types');

const normalized = normalizeCloneSaleWindows([
  { name: 'General Admission', saleStartDate: '2026-09-03', saleEndDate: '2026-09-20', isActive: true },
]);
assert(normalized[0].sale_start_time === '2026-09-03T00:00:00-04:00', 'confirmed start must become an API timestamp');
assert(normalized[0].sale_end_time === '2026-09-20T23:59:59-04:00', 'confirmed end must become an API timestamp');
const blankOk = normalizeCloneSaleWindows(
  [{ name: 'General Admission', saleStartDate: '', saleEndDate: '', isActive: false }],
  { expectedCount: 1, allowBlankDates: true }
);
assert(blankOk[0].sale_start_time === '' && blankOk[0].sale_end_time === '', 'existing mode may confirm blank live dates');

let orderError = '';
try {
  normalizeCloneSaleWindow({ name: 'VIP', saleStartDate: '2026-09-20', saleEndDate: '2026-09-01' });
} catch (error) {
  orderError = error.message;
}
assert(/on or after sale start/i.test(orderError), 'end before start must be rejected');

const fromRatesOnly = buildCloneSaleWindowsFromSource(
  [],
  [{ name: 'Door' }],
  { today: '2026-09-03', eventDate: '2026-09-20' }
);
assert(fromRatesOnly[0].saleStartDate === '2026-09-03', 'rate only rows default sale start to today');
assert(fromRatesOnly[0].saleEndDate === '2026-09-20', 'rate only rows default sale end to the event day');

assert(adminHtml.includes('id="cloneSaleConfirmed"'), 'clone modal must require an explicit confirmation checkbox');
assert(/data-clone-sale-active="\$\{index\}"[^>]*disabled/.test(adminHtml), 'Active status must be display only');
assert(/allowBlankDates:\s*!!existingEventIdForCount/.test(fs.readFileSync(new URL('../functions/admin/api/projects.js', import.meta.url), 'utf8')), 'existing bind must allow blank live sale dates');
assert(adminHtml.includes('id="cloneSaleWindows"'), 'clone modal must list editable sale windows');
assert(/ticketSaleWindows/.test(adminHtml), 'clone request must send confirmed ticketSaleWindows');
assert(/normalizeCloneSaleWindows/.test(projectsJs), 'clone API must validate confirmed sale windows');
assert(
  projectsJs.includes('from "../../_lib/clone-sale-windows.js"'),
  'clone API must use the shared sale window helpers'
);
assert(/payload\.sale_start_time\s*=\s*window\.sale_start_time/.test(projectsJs), 'clone ticket create must apply confirmed sale start');
assert(/payload\.sale_end_time\s*=\s*window\.sale_end_time/.test(projectsJs), 'clone ticket create must apply confirmed sale end');
assert(
  /Existing bind reuses live ticket types/.test(projectsJs),
  'existing event clones must review sale windows without rewriting live tickets'
);
assert(
  !/bound = await applyConfirmedSaleWindows/.test(projectsJs),
  'clone bind path must not patch live sale windows'
);
assert(/skipTicketSaleSync:\s*true/.test(adminHtml), 'clone date move must skip sale end overwrite');
assert(/skipTicketSaleSync/.test(fs.readFileSync(new URL('../functions/admin/api/events.js', import.meta.url), 'utf8')), 'date sync must honor skipTicketSaleSync');
assert(
  !/function loadCloneSaleWindows[\s\S]*?inspectedProject\.rates/.test(adminHtml),
  'clone sale rows must not seed from inspectedProject'
);
assert(/async function loadCloneSourceRates/.test(adminHtml), 'clone must load rates from the projects API');
assert(/inventDefaults:\s*false/.test(adminHtml), 'existing mode must not invent missing live sale dates');
assert(/readonly:\s*mode === "existing"/.test(adminHtml), 'existing mode sale inputs must be readonly');
assert(!/fix windows later in Checkout/.test(adminHtml), 'clone hints must not claim Checkout edits sale windows');
assert(/requireDates:\s*mode === "new"/.test(adminHtml), 'HTML required must apply only in new mode');
assert(/cloneAlignedEventDay/.test(adminHtml), 'clone date changes must track the aligned event day');
assert(/fetchEventTickets\(context, accessToken, existingEventIdForCount\)/.test(
  fs.readFileSync(new URL('../functions/admin/api/projects.js', import.meta.url), 'utf8')
), 'existing mode must count tickets before creating the clone draft');
assert(/api\("\/admin\/api\/projects"/.test(adminHtml), 'clone rate loader must call /admin/api/projects');
assert(
  /const rates = await loadCloneSourceRates\(\)/.test(adminHtml),
  'new clone mode must await loaded project rates, not selected.claudeDesign'
);
assert(/America\/Curacao/.test(adminHtml), 'clone defaults must use Curacao local today');
assert(/ticketsByName/.test(adminHtml), 'new clone mode must match source tickets to rates by name');
assert(/function setCloneSaleConfirmed/.test(adminHtml), 'clone confirm helper must keep the adjust-dates message in sync');


assert(toCuracaoOffsetIso('2026-09-21T01:00:00.000Z') === '2026-09-20T21:00:00-04:00', 'UTC evening must become Curacao wall clock');
assert(curacaoDayFromValue('2026-09-21T01:00:00.000Z') === '2026-09-20', 'Curacao day must not use UTC date slice');
const shifted = shiftCloneEventDay('2026-09-21T01:00:00.000Z', '2026-09-21T04:00:00.000Z', '2026-09-20');
assert(shifted.startDate === '2026-09-20T21:00:00-04:00', 'same-day shift must keep 9pm Curacao');
assert(shifted.endDate === '2026-09-21T00:00:00-04:00', 'same-day shift must keep midnight Curacao end');
const moved = shiftCloneEventDay('2026-09-21T01:00:00.000Z', '2026-09-21T04:00:00.000Z', '2026-11-06');
assert(moved.startDate === '2026-11-06T21:00:00-04:00', 'moved day must keep 9pm Curacao');
assert(/shiftCloneEventDay\(/.test(projectsJs), 'clone API must shift chosen day via shared helper');
assert(/rewriteProjectDate\(bound, shifted\.startDate, shifted\.endDate\)/.test(projectsJs), 'clone must rewrite labels with shifted ISO timestamps');
assert(!/requestedStart/.test(projectsJs), 'clone must not stash a plain YYYY-MM-DD startDate before create');
assert(/cloneDayValue\(data\.project && data\.project\.startDate\)/.test(adminHtml), 'client must compare bound day in Curacao time');
assert(/cloneSourceDate = cloneDayValue\(info\.startDate\)/.test(adminHtml), 'clone modal must prefill the Curacao day, not the UTC date slice');

if (failures.length) {
  console.error('check-clone-sale-windows FAILED:');
  failures.forEach((failure) => console.error(' - ' + failure));
  process.exit(1);
}

console.log('check-clone-sale-windows OK (forced sale window confirmation on clone)');
