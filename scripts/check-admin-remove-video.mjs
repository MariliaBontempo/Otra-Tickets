// Oracle: the admin video-section editor can remove ONLY the video, keeping
// the poster image, and the removal is reversible by uploading a new video.
// Run: node scripts/check-admin-remove-video.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const failures = [];
const assert = (c, m) => { if (!c) failures.push(m); };

function extractFunction(name) {
  const start = html.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') { depth -= 1; if (depth === 0) return html.slice(start, i + 1); }
  }
  return '';
}

const names = ['isVideoValue', 'isVideoSectionField', 'videoKeysToRemove', 'removeVideoFields', 'updateVideoSlotFields'];
const src = names.map(extractFunction);
names.forEach((n, i) => assert(src[i], `${n} must exist in admin/index.html`));

assert(/<button[^>]*id="removeVideoBtn"[^>]*class="[^"]*hidden|<button[^>]*class="[^"]*hidden[^"]*"[^>]*id="removeVideoBtn"/.test(html),
  'removeVideoBtn must exist and start hidden');
assert(/\$\("removeVideoBtn"\)\.classList\.toggle\("hidden"/.test(html), 'openEditor must toggle removeVideoBtn');
assert(/persistOverrideFields\(\(next\) => removeVideoFields\(next, activeKey\)\)/.test(html),
  'Remove video must persist through persistOverrideFields (own page override only)');

const openEditorSrc = extractFunction('openEditor');
assert(/canRemoveVideo = isImage && isVideoSectionField\(activeField\)/.test(openEditorSrc) &&
  /\$\("removeVideoBtn"\)\.classList\.toggle\("hidden", !canRemoveVideo\)/.test(openEditorSrc),
  'openEditor shows Remove video only for an image edit of the video section that has a video');
const handler = html.slice(html.indexOf('$("removeVideoBtn").addEventListener'), html.indexOf('function applyAccentToPreview'));
assert(/confirm\(/.test(handler), 'Remove video asks for confirmation');
assert(/if \(!videoKeysToRemove\(fields, activeField\.key\)\.length\)/.test(handler), 'handler re-checks there is a video before saving');
assert(/refreshPreview\(\)/.test(handler), 'preview reloads after removal');
assert(!/publish/i.test(handler), 'Remove video never publishes');

if (src.every(Boolean)) {
  const sb = {};
  vm.runInNewContext(`${src.join('\n')}; this.f = { ${names.join(',')} };`, sb);
  const f = sb.f;
  const K = 'image:#evVideoImg', V = 'video:#evVideoImg';

  // Clone of Clearboat: separate video + poster fields.
  let fields = {
    [K]: { type: 'image', value: '/override-images/poster.jpg' },
    [V]: { type: 'image', value: '/override-images/clearboat-30s.mp4' },
    'text:#evTitle': { type: 'text', value: 'Water Bikes' },
    'image:#evHeroImg': { type: 'image', value: '/override-images/hero.mp4' },
    'video:#otherSlot': { type: 'image', value: '/override-images/other.mp4' },
  };
  f.removeVideoFields(fields, K);
  assert(!fields[V], 'video field removed');
  assert(fields[K] && fields[K].value === '/override-images/poster.jpg', 'poster kept');
  assert(fields['text:#evTitle'], 'unrelated text kept');
  assert(fields['image:#evHeroImg'], 'video elsewhere on page (not the video section) kept');
  assert(fields['video:#otherSlot'], 'video field of another slot kept');

  // Legacy: video stored in the image field itself.
  fields = { [K]: { type: 'image', value: '/override-images/old.mp4' } };
  assert(f.videoKeysToRemove(fields, K).length === 1, 'legacy video detected');
  f.removeVideoFields(fields, K);
  assert(!fields[K], 'legacy video removed, design image falls back');

  // Nothing to remove.
  fields = { [K]: { type: 'image', value: '/override-images/poster.jpg' } };
  assert(f.videoKeysToRemove(fields, K).length === 0, 'poster-only slot offers nothing to remove');
  assert(f.videoKeysToRemove(undefined, K).length === 0, 'missing fields handled');

  // Reversible: uploading a video again restores the video field, poster kept.
  f.updateVideoSlotFields(fields, K, V, '/override-images/new.mp4', true);
  assert(fields[V] && fields[V].value === '/override-images/new.mp4', 're-upload restores video');
  assert(fields[K].value === '/override-images/poster.jpg', 're-upload keeps poster');

  // Section detection.
  assert(f.isVideoSectionField({ key: K }), 'evVideoImg key is video section');
  assert(!f.isVideoSectionField({ key: 'image:#evHeroImg', element: { closest: () => null } }), 'hero is not video section');
  assert(f.isVideoSectionField({ key: 'image:section > video', element: { closest: () => ({}) } }), 'element inside .ev-video is video section');
  assert(!f.isVideoSectionField({ key: 'text:#evVideoImg' }), 'text fields are not');
  assert(!f.isVideoSectionField(null), 'null field');
}

if (failures.length) { console.error('FAIL\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('PASS admin remove video');
