// Oracle: cloning forces confirmation of ticket sale start and end dates.
// Run: node scripts/check-clone-sale-windows.mjs

import fs from 'node:fs';
import { URL } from 'node:url';
import {
  buildCloneSaleWindowsFromSource,
  cloneSaleWindowWarnings,
  dayToSaleEndIso,
  dayToSaleStartIso,
  normalizeCloneSaleWindow,
  normalizeCloneSaleWindows,
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
assert(/confirm ticket sale/i.test(missingError), 'empty confirmation must fail closed');

const normalized = normalizeCloneSaleWindows([
  { name: 'General Admission', saleStartDate: '2026-09-03', saleEndDate: '2026-09-20', isActive: true },
]);
assert(normalized[0].sale_start_time === '2026-09-03T00:00:00-04:00', 'confirmed start must become an API timestamp');
assert(normalized[0].sale_end_time === '2026-09-20T23:59:59-04:00', 'confirmed end must become an API timestamp');

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
assert(adminHtml.includes('id="cloneSaleWindows"'), 'clone modal must list editable sale windows');
assert(/ticketSaleWindows/.test(adminHtml), 'clone request must send confirmed ticketSaleWindows');
assert(/normalizeCloneSaleWindows/.test(projectsJs), 'clone API must validate confirmed sale windows');
assert(/sale_start_time:\s*window\.sale_start_time/.test(projectsJs), 'clone ticket create must apply confirmed sale start');
assert(/sale_end_time:\s*window\.sale_end_time/.test(projectsJs), 'clone ticket create must apply confirmed sale end');
assert(/applyConfirmedSaleWindows/.test(projectsJs), 'existing event clones must patch confirmed sale windows');

if (failures.length) {
  console.error('check-clone-sale-windows FAILED:');
  failures.forEach((failure) => console.error(' - ' + failure));
  process.exit(1);
}

console.log('check-clone-sale-windows OK (forced sale window confirmation on clone)');
