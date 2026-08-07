// Oracle: the admin editor stays usable on small screens - the toolbar wraps
// instead of running off the right edge, the page selector cannot stretch
// past the viewport, and the preview fills whatever height the wrapped
// toolbar leaves over (no hard-coded topbar heights).
// Run: node scripts/check-admin-responsive.mjs

import fs from 'node:fs';
import { URL } from 'node:url';

const adminHtml = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const narrowQuery = adminHtml.match(/@media \(max-width: 980px\) \{[\s\S]*?\n  \}/);
assert(narrowQuery, 'the 980px media query must exist');
if (narrowQuery) {
  assert(
    /\.topbar \.row\.split[^}]*flex-wrap:\s*wrap/.test(narrowQuery[0]),
    'the toolbar action row must wrap on small screens or Publish/Sign out fall off-screen'
  );
  assert(
    /\.topbar \.top-status[^}]*flex:\s*1 1 100%/.test(narrowQuery[0]),
    'the status line must take its own row instead of squeezing into a one-word column'
  );
  assert(
    !/iframe[^}]*calc\(100vh/.test(narrowQuery[0]),
    'the preview must not hard-code the topbar height - a wrapped toolbar changes it'
  );
}

assert(
  /@media \(max-width: 640px\)/.test(adminHtml),
  'a phone-width breakpoint must tighten paddings'
);

assert(
  /#pageSelect \{[^}]*min-width:\s*0/.test(adminHtml),
  'the page selector needs min-width:0 or a long title stretches it past the viewport'
);

const iframeRule = adminHtml.match(/\n  iframe \{[^}]*\}/);
assert(iframeRule, 'the preview iframe rule must exist');
if (iframeRule) {
  assert(
    /height:\s*100%/.test(iframeRule[0]) && !/calc\(100vh/.test(iframeRule[0]),
    'the preview iframe must fill its grid cell instead of hard-coding viewport math'
  );
}

assert(
  /\.modal \{[^}]*width:\s*min\(620px, 100%\)/.test(adminHtml),
  'modals must never exceed the viewport width'
);

if (failures.length) {
  console.error(`check-admin-responsive: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('check-admin-responsive: all assertions passed');
