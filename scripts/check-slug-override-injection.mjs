// Oracle: dynamic event-slug pages must inject their event/draft id into the
// site-overrides script regardless of the script's cache-busting version.
// Run: node scripts/check-slug-override-injection.mjs

import { injectOverrideId } from '../functions/[slug].js';

const failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
}

for (const src of [
  '/site-overrides.js?v=5',
  '/site-overrides.js?v=6',
  '/site-overrides.js?v=7',
  '/site-overrides.js?v=999',
  '/site-overrides.js',
]) {
  const input = `<html><body><script defer src="${src}"></script></body></html>`;
  const result = injectOverrideId(input, 'draft-abc-123');
  assert(
    result.includes(`src="${src}" data-override-id="draft-abc-123"`),
    `${src} must receive the draft override id`,
  );
}

const numeric = injectOverrideId(
  '<script src="/site-overrides.js?v=7"></script>',
  '6832',
);
assert(
  numeric.includes('data-override-id="6832"'),
  'numeric event ids must be injected',
);

const existing = '<script src="/site-overrides.js?v=7" data-override-id="7456"></script>';
assert(
  injectOverrideId(existing, '9999') === existing,
  'an existing override id must not be duplicated or replaced',
);

const unrelated = '<script src="/other.js?v=6"></script>';
assert(
  injectOverrideId(unrelated, '6832') === unrelated,
  'unrelated scripts must remain unchanged',
);

const escaped = injectOverrideId(
  '<script src="/site-overrides.js?v=7"></script>',
  'draft-a"<b',
);
assert(
  escaped.includes('data-override-id="draft-a&quot;&lt;b"'),
  'the injected id must be HTML-escaped',
);

if (failures.length) {
  console.error('check-slug-override-injection FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('check-slug-override-injection OK (version-independent override id injection)');
