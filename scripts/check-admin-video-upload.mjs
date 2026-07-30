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

function extractFunction(name) {
  const start = html.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = html.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  return '';
}

const accept = html.match(/id="imageInput"[^>]*\baccept="([^"]+)"/)?.[1] || '';
for (const value of ['video/*', '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']) {
  assert(accept.split(',').includes(value), `imageInput accept must include ${value}`);
}

const videoFileSource = extractFunction('isVideoFile');
assert(videoFileSource, 'isVideoFile must exist in admin/index.html');

let isVideoFile;
if (videoFileSource) {
  const sandbox = {};
  vm.runInNewContext(`${videoFileSource}; this.result = isVideoFile;`, sandbox);
  isVideoFile = sandbox.result;
}

if (isVideoFile) {
  const cases = [
    [{ name: 'promo.mp4', type: 'video/mp4' }, true, 'standard MP4 MIME'],
    [{ name: 'iphone.MOV', type: 'video/quicktime' }, true, 'QuickTime MIME'],
    [{ name: 'camera.m4v', type: '' }, true, 'empty MIME with M4V extension'],
    [{ name: 'export.mkv', type: 'application/octet-stream' }, true, 'generic MIME with MKV extension'],
    [{ name: 'legacy.avi', type: '' }, true, 'empty MIME with AVI extension'],
    [{ name: 'photo.png', type: 'image/png' }, false, 'PNG photo'],
    [{ name: 'poster.jpg', type: 'image/jpeg' }, false, 'JPEG poster'],
    [{ name: 'poster.webp', type: 'image/webp' }, false, 'WebP poster'],
    [{ name: 'poster.avif', type: 'image/avif' }, false, 'AVIF poster'],
    [{ name: 'notes.txt', type: 'text/plain' }, false, 'non-media file'],
    [null, false, 'missing file'],
  ];
  for (const [file, expected, label] of cases) {
    assert(isVideoFile(file) === expected, `${label}: expected ${expected}`);
  }
}

const videoValueSource = extractFunction('isVideoValue');
const updateFieldsSource = extractFunction('updateVideoSlotFields');
assert(videoValueSource, 'isVideoValue must exist in admin/index.html');
assert(updateFieldsSource, 'updateVideoSlotFields must exist in admin/index.html');

let updateVideoSlotFields;
if (videoValueSource && updateFieldsSource) {
  const sandbox = {};
  vm.runInNewContext(
    `${videoValueSource}; ${updateFieldsSource}; this.result = updateVideoSlotFields;`,
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

// Execute the real image optimizer with controlled browser primitives. This
// protects the pre-existing photo path while video handling changes around it.
const optimizeImageSource = extractFunction('optimizeImage');
assert(optimizeImageSource, 'optimizeImage must exist in admin/index.html');

if (optimizeImageSource) {
  const bitmapPlans = [];
  const canvases = [];
  class MockFile {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = options.type;
      this.size = parts.reduce((sum, part) => sum + Number(part.size || 0), 0);
    }
  }
  const sandbox = {
    OPTIMIZE_MAX_DIM: 2000,
    OPTIMIZE_SKIP_BYTES: 600 * 1024,
    File: MockFile,
    createImageBitmap: async () => {
      const plan = bitmapPlans.shift();
      if (plan instanceof Error) throw plan;
      return plan;
    },
    document: {
      createElement(tag) {
        assert(tag === 'canvas', 'optimizer must create a canvas for a large photo');
        const canvas = {
          width: 0,
          height: 0,
          drawCalls: 0,
          getContext: () => ({
            drawImage: () => { canvas.drawCalls += 1; },
          }),
          toBlob: (callback, type, quality) => {
            canvas.outputType = type;
            canvas.quality = quality;
            callback({ size: 1000, type });
          },
        };
        canvases.push(canvas);
        return canvas;
      },
    },
  };
  vm.runInNewContext(`${optimizeImageSource}; this.optimize = optimizeImage;`, sandbox);

  let smallClosed = false;
  const small = { name: 'small.jpg', type: 'image/jpeg', size: 100_000 };
  bitmapPlans.push({ width: 800, height: 600, close: () => { smallClosed = true; } });
  const smallResult = await sandbox.optimize(small);
  assert(smallResult === small, 'small JPEG must remain unchanged');
  assert(smallClosed, 'small JPEG bitmap must be released');

  let largeClosed = false;
  const large = { name: 'camera.png', type: 'image/png', size: 5_000_000 };
  bitmapPlans.push({ width: 4000, height: 3000, close: () => { largeClosed = true; } });
  const largeResult = await sandbox.optimize(large);
  const canvas = canvases.at(-1);
  assert(largeResult.name === 'camera.webp', 'large photo must be renamed to WebP');
  assert(largeResult.type === 'image/webp', 'large photo must be encoded as WebP');
  assert(canvas?.width === 2000 && canvas?.height === 1500, 'large photo must be downscaled within 2000px');
  assert(canvas?.drawCalls === 1, 'large photo must be drawn once');
  assert(canvas?.outputType === 'image/webp' && canvas?.quality === 0.85, 'WebP encoding settings must stay unchanged');
  assert(largeClosed, 'large photo bitmap must be released');

  const svg = { name: 'vector.svg', type: 'image/svg+xml', size: 10_000 };
  const svgResult = await sandbox.optimize(svg);
  assert(svgResult === svg, 'unsupported image formats must pass through unchanged');

  const broken = { name: 'broken.avif', type: 'image/avif', size: 900_000 };
  bitmapPlans.push(new Error('decode failed'));
  const brokenResult = await sandbox.optimize(broken);
  assert(brokenResult === broken, 'image optimization failure must fall back to the original file');
}

// Execute uploadCurrentImage itself with mocked network/DOM dependencies.
// This verifies endpoint routing and persistence, not only helper functions.
const uploadCurrentImageSource = extractFunction('uploadCurrentImage');
assert(uploadCurrentImageSource, 'uploadCurrentImage must exist in admin/index.html');

async function runUploadScenario({ file, activeField, optimizedFile, holdPipeline = false }) {
  const calls = {
    statuses: [],
    optimize: [],
    imageApi: [],
    pipeline: [],
    busy: [],
    progress: [],
    persistCurrent: 0,
    persistFields: 0,
    showImage: [],
    closeModal: 0,
    refreshPreview: 0,
    hideProgress: 0,
  };
  const elements = {
    imageInput: { files: [file], value: 'chosen' },
    uploadBtn: { disabled: false },
    saveBtn: { disabled: false },
    closeModalBtn: { disabled: false },
    cancelBtn: { disabled: false },
    clearImageBtn: { disabled: false },
    imageUrl: { value: '' },
  };
  const fields = {};
  let resolvePipeline;
  const pipelineGate = holdPipeline
    ? new Promise((resolve) => { resolvePipeline = resolve; })
    : null;
  class MockFormData {
    constructor() { this.values = new Map(); }
    set(key, value) { this.values.set(key, value); }
  }
  const sandbox = {
    selected: { id: 'draft-test' },
    activeField,
    mediaUploadBusy: false,
    $: (id) => elements[id],
    setStatus: (text, type) => calls.statuses.push({ text, type }),
    showUploadProgress: (text, fraction) => calls.progress.push({ text, fraction }),
    optimizeImage: async (value) => {
      calls.optimize.push(value);
      return optimizedFile || value;
    },
    uploadVideoViaPipeline: async (value) => {
      calls.pipeline.push(value);
      if (pipelineGate) await pipelineGate;
      return '/override-images/draft-test/video.mp4';
    },
    FormData: MockFormData,
    overrideIdForPage: () => 'draft-test',
    api: async (path, options) => {
      calls.imageApi.push({ path, options });
      return { url: '/override-images/draft-test/photo.webp' };
    },
    authHeaders: () => ({ authorization: 'Bearer test' }),
    showImage: (url) => calls.showImage.push(url),
    persistOverrideFields: async (mutate) => {
      calls.persistFields += 1;
      mutate(fields);
    },
    persistCurrentOverride: async () => { calls.persistCurrent += 1; },
    closeModal: () => { calls.closeModal += 1; },
    refreshPreview: () => { calls.refreshPreview += 1; },
    hideUploadProgress: () => { calls.hideProgress += 1; },
  };
  sandbox.setMediaUploadBusy = (busy) => {
    sandbox.mediaUploadBusy = !!busy;
    calls.busy.push(!!busy);
    for (const id of ['uploadBtn', 'saveBtn', 'closeModalBtn', 'cancelBtn', 'clearImageBtn', 'imageInput']) {
      elements[id].disabled = !!busy;
    }
  };
  vm.runInNewContext(
    `${videoValueSource}; ${videoFileSource}; ${updateFieldsSource}; ${uploadCurrentImageSource}; this.upload = uploadCurrentImage;`,
    sandbox
  );
  const uploadPromise = sandbox.upload();
  if (!holdPipeline) await uploadPromise;
  return { calls, elements, fields, sandbox, uploadPromise, resolvePipeline };
}

if (uploadCurrentImageSource && videoValueSource && videoFileSource && updateFieldsSource) {
  const photo = { name: 'hero.jpg', type: 'image/jpeg', size: 2_000_000 };
  const optimized = { name: 'hero.webp', type: 'image/webp', size: 300_000 };
  const normalImage = await runUploadScenario({
    file: photo,
    optimizedFile: optimized,
    activeField: { key: 'image:#evHeroImg', type: 'image' },
  });
  assert(normalImage.calls.optimize[0] === photo, 'ordinary photo must still run through optimizeImage');
  assert(normalImage.calls.pipeline.length === 0, 'ordinary photo must not enter the video pipeline');
  assert(normalImage.calls.imageApi.length === 1, 'ordinary photo must call the image upload API once');
  assert(normalImage.calls.imageApi[0]?.path === '/admin/api/upload', 'ordinary photo must use /admin/api/upload');
  assert(normalImage.calls.imageApi[0]?.options?.body?.values.get('id') === 'draft-test', 'image upload must keep the event id');
  assert(normalImage.calls.imageApi[0]?.options?.body?.values.get('file') === optimized, 'image upload must send the optimized file');
  assert(normalImage.calls.persistCurrent === 1, 'ordinary image slot must keep the previous persistCurrentOverride path');
  assert(normalImage.calls.persistFields === 0, 'ordinary image slot must not use video-slot persistence');
  assert(normalImage.elements.imageUrl.value === '/override-images/draft-test/photo.webp', 'ordinary image URL must be saved');

  const poster = await runUploadScenario({
    file: photo,
    optimizedFile: optimized,
    activeField: { key: 'image:#evVideoImg', type: 'image' },
  });
  assert(poster.calls.imageApi.length === 1, 'video thumbnail photo must still use the image upload API');
  assert(poster.calls.pipeline.length === 0, 'video thumbnail photo must not enter the video pipeline');
  assert(poster.calls.persistCurrent === 0 && poster.calls.persistFields === 1, 'video thumbnail must use separated-field persistence');
  assert(poster.fields['image:#evVideoImg']?.value === '/override-images/draft-test/photo.webp', 'video thumbnail must be stored in image:');

  const video = { name: 'promo.m4v', type: '', size: 3_000_000 };
  const videoUpload = await runUploadScenario({
    file: video,
    activeField: { key: 'image:#evVideoImg', type: 'image' },
  });
  assert(videoUpload.calls.optimize.length === 0, 'video must skip image optimization');
  assert(videoUpload.calls.imageApi.length === 0, 'video must not call the image upload API');
  assert(videoUpload.calls.pipeline[0] === video, 'video must use the video pipeline');
  assert(videoUpload.fields['video:#evVideoImg']?.value === '/override-images/draft-test/video.mp4', 'video must be stored in video:');

  for (const [label, result] of [['ordinary image', normalImage], ['poster', poster], ['video', videoUpload]]) {
    assert(result.calls.closeModal === 1, `${label} upload must close the modal after saving`);
    assert(result.calls.refreshPreview === 1, `${label} upload must refresh the preview`);
    assert(result.calls.hideProgress === 1, `${label} upload must clear progress state`);
    assert(result.elements.uploadBtn.disabled === false, `${label} upload must re-enable Upload`);
    assert(result.elements.saveBtn.disabled === false, `${label} upload must re-enable Save`);
    assert(result.elements.imageInput.value === '', `${label} upload must clear the file input`);
    assert(result.calls.busy[0] === true && result.calls.busy.at(-1) === false, `${label} upload must lock then unlock media controls`);
  }

  const lockedUpload = await runUploadScenario({
    file: video,
    activeField: { key: 'image:#evVideoImg', type: 'image' },
    holdPipeline: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert(lockedUpload.sandbox.mediaUploadBusy === true, 'large video must lock immediately before network completion');
  assert(lockedUpload.calls.progress[0]?.text.includes('Preparing 3 MB video upload'), 'video must show preparing progress immediately');
  for (const id of ['uploadBtn', 'saveBtn', 'closeModalBtn', 'cancelBtn', 'clearImageBtn', 'imageInput']) {
    assert(lockedUpload.elements[id].disabled === true, `${id} must be disabled during a video upload`);
  }
  await lockedUpload.sandbox.upload();
  assert(lockedUpload.calls.pipeline.length === 1, 'a second Save must not start another pipeline upload');
  assert(
    lockedUpload.calls.statuses.some((entry) => entry.text.includes('already in progress')),
    'a second Save must explain that the upload is already running'
  );
  lockedUpload.resolvePipeline();
  await lockedUpload.uploadPromise;
  assert(lockedUpload.sandbox.mediaUploadBusy === false, 'media lock must clear after upload completion');
}

const setMediaUploadBusySource = extractFunction('setMediaUploadBusy');
const closeModalSource = extractFunction('closeModal');
assert(setMediaUploadBusySource, 'setMediaUploadBusy must exist in admin/index.html');
assert(closeModalSource, 'closeModal must exist in admin/index.html');

if (setMediaUploadBusySource) {
  const ids = ['uploadBtn', 'saveBtn', 'closeModalBtn', 'cancelBtn', 'clearImageBtn', 'imageInput'];
  const elements = Object.fromEntries(ids.map((id) => [id, { disabled: false }]));
  const sandbox = { mediaUploadBusy: false, $: (id) => elements[id] };
  vm.runInNewContext(`${setMediaUploadBusySource}; this.setBusy = setMediaUploadBusy;`, sandbox);
  sandbox.setBusy(true);
  assert(sandbox.mediaUploadBusy === true, 'setMediaUploadBusy(true) must set the shared lock');
  for (const id of ids) assert(elements[id].disabled === true, `${id} must be disabled by the real lock helper`);
  sandbox.setBusy(false);
  for (const id of ids) assert(elements[id].disabled === false, `${id} must be re-enabled by the real lock helper`);
}

if (closeModalSource) {
  const modal = { hidden: false, classList: { add: () => { modal.hidden = true; } } };
  const statuses = [];
  const sandbox = {
    mediaUploadBusy: true,
    modalMode: 'image',
    activeField: { key: 'image:#evVideoImg' },
    $: () => modal,
    setStatus: (text, type) => statuses.push({ text, type }),
  };
  vm.runInNewContext(`${closeModalSource}; this.close = closeModal;`, sandbox);
  sandbox.close();
  assert(modal.hidden === false, 'Cancel/backdrop must not close the modal during upload');
  assert(statuses[0]?.text.includes('Upload in progress'), 'blocked close must explain why');
  sandbox.close(true);
  assert(modal.hidden === true, 'successful upload may force-close the modal');
  assert(sandbox.modalMode === '' && sandbox.activeField === null, 'forced close must reset editor state');
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

console.log('check-admin-video-upload OK (photo optimization/upload + picker routing + image/video order + legacy migration)');
