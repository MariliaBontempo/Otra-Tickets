// Oracle: the admin file picker must accept common video extensions even when
// macOS/Chrome reports an empty or generic MIME type, and those files must be
// routed through the video pipeline rather than the image upload endpoint.
// Run: node scripts/check-admin-video-upload.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const accept = html.match(/id="imageInput"[^>]*\baccept="([^"]+)"/)?.[1] || '';
for (const value of ['video/*', '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']) {
  assert(accept.split(',').includes(value), `imageInput accept must include ${value}`);
}

const functionMatch = html.match(/function isVideoFile\(file\) \{[\s\S]*?\n  \}/);
assert(functionMatch, 'isVideoFile must exist in admin/index.html');

let isVideoFile;
if (functionMatch) {
  const sandbox = {};
  vm.runInNewContext(`${functionMatch[0]}; this.result = isVideoFile;`, sandbox);
  isVideoFile = sandbox.result;
}

if (isVideoFile) {
  const cases = [
    [{ name: 'promo.mp4', type: 'video/mp4' }, true, 'standard MP4 MIME'],
    [{ name: 'iphone.MOV', type: 'video/quicktime' }, true, 'QuickTime MIME'],
    [{ name: 'camera.m4v', type: '' }, true, 'empty MIME with M4V extension'],
    [{ name: 'export.mkv', type: 'application/octet-stream' }, true, 'generic MIME with MKV extension'],
    [{ name: 'legacy.avi', type: '' }, true, 'empty MIME with AVI extension'],
    [{ name: 'poster.jpg', type: 'image/jpeg' }, false, 'JPEG poster'],
    [{ name: 'notes.txt', type: 'text/plain' }, false, 'non-media file'],
    [null, false, 'missing file'],
  ];
  for (const [file, expected, label] of cases) {
    assert(isVideoFile(file) === expected, `${label}: expected ${expected}`);
  }
}

const videoValueMatch = html.match(/function isVideoValue\(value\) \{[\s\S]*?\n  \}/);
const updateFieldsMatch = html.match(/function updateVideoSlotFields\(fields, imageKey, videoKey, value, isVideo\) \{[\s\S]*?\n  \}/);
assert(videoValueMatch, 'isVideoValue must exist in admin/index.html');
assert(updateFieldsMatch, 'updateVideoSlotFields must exist in admin/index.html');

let updateVideoSlotFields;
if (videoValueMatch && updateFieldsMatch) {
  const sandbox = {};
  vm.runInNewContext(
    `${videoValueMatch[0]}; ${updateFieldsMatch[0]}; this.result = updateVideoSlotFields;`,
    sandbox
  );
  updateVideoSlotFields = sandbox.result;
}

if (updateVideoSlotFields) {
  const imageKey = 'image:#evVideoImg';
  const videoKey = 'video:#evVideoImg';

  const imageThenVideo = {};
  updateVideoSlotFields(imageThenVideo, imageKey, videoKey, '/poster.jpg', false);
  updateVideoSlotFields(imageThenVideo, imageKey, videoKey, '/clip.mp4', true);
  assert(imageThenVideo[imageKey]?.value === '/poster.jpg', 'image -> video must preserve the poster');
  assert(imageThenVideo[videoKey]?.value === '/clip.mp4', 'image -> video must save the video separately');

  const videoThenImage = {};
  updateVideoSlotFields(videoThenImage, imageKey, videoKey, '/clip.mp4', true);
  updateVideoSlotFields(videoThenImage, imageKey, videoKey, '/poster.jpg', false);
  assert(videoThenImage[videoKey]?.value === '/clip.mp4', 'video -> image must preserve the video');
  assert(videoThenImage[imageKey]?.value === '/poster.jpg', 'video -> image must save the poster separately');

  const legacyVideoThenImage = {
    [imageKey]: { type: 'image', value: '/legacy.mov' },
  };
  updateVideoSlotFields(legacyVideoThenImage, imageKey, videoKey, '/poster.jpg', false);
  assert(legacyVideoThenImage[videoKey]?.value === '/legacy.mov', 'legacy video must migrate before saving a poster');
  assert(legacyVideoThenImage[imageKey]?.value === '/poster.jpg', 'legacy migration must leave the new poster in image:');
}

assert(
  /const isVideo = isVideoFile\(file\);/.test(html),
  'uploadCurrentImage must use isVideoFile so extension fallback reaches the video pipeline'
);

if (failures.length) {
  console.error('check-admin-video-upload FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('check-admin-video-upload OK (picker routing + image/video order + legacy migration)');
