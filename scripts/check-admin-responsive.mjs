// Oracle: the admin editor stays usable on small screens - the toolbar wraps
// instead of running off the right edge, the page selector cannot stretch
// past the viewport, and the preview fills whatever height the wrapped
// toolbar leaves over (no hard-coded topbar heights). The preview must also
// stay responsive: pencil overlays reposition when the iframe resizes, and
// the previewed pages themselves never build horizontal overflow (carousel
// arrows fit their icon, long info values wrap, titles scale on tiny phones).
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

// Between 981px and ~1300px the full toolbar is wider than the viewport, so
// wrapping must be allowed at every width, not only inside the 980px query.
const baseWrap = adminHtml.match(/\n  \.topbar \.row\.split \{[^}]*\}/);
assert(
  baseWrap && /flex-wrap:\s*wrap/.test(baseWrap[0]),
  'the toolbar action row must be allowed to wrap at every width (981-1300px overflows too)'
);

// Pencil overlays are positioned in pixels against the layout at injection
// time; without a resize re-run they pin the preview to its old width and the
// page stops looking responsive.
assert(
  /function repositionPreviewButtons\(/.test(adminHtml),
  'repositionPreviewButtons must exist so pencils follow the preview layout'
);
assert(
  /function watchPreviewResizes\(/.test(adminHtml) &&
    /watchPreviewResizes\(doc\)/.test(adminHtml.replace(/function watchPreviewResizes[\s\S]*?\n  \}/, '')),
  'injectEditControls must hook preview resizes to reposition the pencils'
);
assert(
  /addEventListener\("resize",/.test(adminHtml),
  'a resize listener must trigger the pencil repositioning'
);

// The previewed pages themselves: no page-level horizontal overflow on phones.
for (const pageFile of ['clearboat.html', 'rnb.html']) {
  const html = fs.readFileSync(new URL(`../${pageFile}`, import.meta.url), 'utf8');
  const arrow = html.match(/\n\.arrow \{[\s\S]*?\}/);
  assert(
    arrow && !/width:\s*clamp\(2\dpx/.test(arrow[0]),
    `${pageFile}: the carousel arrow must never be narrower than its 30px icon`
  );
}
for (const pageFile of ['clearboat.html', 'event.html', 'rnb.html']) {
  const html = fs.readFileSync(new URL(`../${pageFile}`, import.meta.url), 'utf8');
  assert(
    /\.ev-info-cell \.v \{[^}]*overflow-wrap:\s*anywhere/.test(html),
    `${pageFile}: long info values (emails, URLs) must wrap instead of widening the grid`
  );
  assert(
    /@media \(max-width: 380px\) \{[\s\S]*?\.ev-titleblock h1 \{[^}]*clamp\(40px/.test(html),
    `${pageFile}: the title font floor must scale down on very narrow phones`
  );
}

if (failures.length) {
  console.error(`check-admin-responsive: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('check-admin-responsive: all assertions passed');
