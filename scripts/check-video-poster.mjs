// Oracle: verifies the video section keeps a video and its poster in separate
// override fields (video: and image:) so neither upload wipes the other, and
// that the existing behaviours the new logic touches still hold:
//   - a still image in an image: field is applied as an image (no <video>)
//   - a video value in an image: field (legacy data) still swaps to a <video>
//   - text: / remove: fields are unaffected
//   - re-application is idempotent (no duplicate <video>)
// Run: node scripts/check-video-poster.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL, URLSearchParams } from 'node:url';

const SOURCE = fs.readFileSync(new URL('../site-overrides.js', import.meta.url), 'utf8');

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}
async function flush() {
  return new Promise((r) => setImmediate(r));
}

// A DOM element mock rich enough for the video-swap path: dataset, classList,
// style.display, closest(".ev-video"), insertAdjacentElement, className.
function makeEl(tagName, init) {
  init = init || {};
  const section = init.section || null; // the .ev-video ancestor, if any
  const classes = new Set(init.classes || []);
  const el = {
    tagName: tagName.toUpperCase(),
    src: init.src || '',
    poster: init.poster || '',
    className: init.className || '',
    controls: false,
    playsInline: false,
    preload: '',
    dataset: {},
    style: {},
    _section: section,
    classList: {
      add: (c) => classes.add(c),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    closest(sel) {
      if (sel === '.ev-video') return el._section;
      return null;
    },
    _inserted: [],
    insertAdjacentElement(pos, node) {
      el._inserted.push({ pos, node });
      // A node inserted next to this element shares its section ancestor.
      node._section = el._section;
      return node;
    },
    remove() {
      el._removed = (el._removed || 0) + 1;
    },
  };
  return el;
}

function makeSection() {
  const classes = new Set();
  return {
    tagName: 'SECTION',
    _classes: classes,
    classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
  };
}

async function runScenario({ fields, selectors }) {
  const timerQueue = [];
  const listeners = {};
  const createdVideos = [];

  const sandbox = {
    document: {
      currentScript: { dataset: { overrideId: '6113' } },
      documentElement: { style: { setProperty() {} } },
      querySelector(sel) {
        return sel in selectors ? selectors[sel] : null;
      },
      querySelectorAll(sel) {
        const parts = sel.split(',').map((s) => s.trim());
        const found = [];
        for (const p of parts) if (selectors[p]) found.push(selectors[p]);
        return { forEach: (fn) => found.forEach(fn) };
      },
      addEventListener(type, fn) {
        (listeners[type] || (listeners[type] = [])).push(fn);
      },
      createElement(tag) {
        if (tag === 'video') {
          const v = makeEl('video', {});
          createdVideos.push(v);
          return v;
        }
        return { tagName: tag.toUpperCase(), textContent: '', innerHTML: '', appendChild() {} };
      },
    },
    location: { search: '', pathname: '/clearboat', href: 'https://otratickets.com/clearboat' },
    fetch() {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ override: { fields: fields || {} } }),
      });
    },
    getComputedStyle() {
      return { getPropertyValue: () => '' };
    },
    Image: class {
      set src(v) { this._src = v; }
      get src() { return this._src; }
      decode() { return Promise.resolve(); }
    },
    URL,
    URLSearchParams,
    setTimeout(cb) { timerQueue.push(cb); },
  };

  vm.runInNewContext(SOURCE, sandbox);
  for (let i = 0; i < 6; i++) await flush();
  let rounds = 0;
  while (timerQueue.length && rounds < 45) {
    const cbs = timerQueue.splice(0);
    for (const cb of cbs) { cb(); for (let i = 0; i < 3; i++) await flush(); }
    rounds++;
  }
  for (let i = 0; i < 3; i++) await flush();

  return {
    createdVideos,
    async dispatch(type) {
      for (const fn of listeners[type] || []) { fn({ type }); for (let i = 0; i < 3; i++) await flush(); }
    },
  };
}

// Helper: the <video> actually placed next to the slot (via insertAdjacentElement).
function insertedVideo(slot) {
  const rec = (slot._inserted || []).find((r) => r.node && r.node.tagName === 'VIDEO');
  return rec ? rec.node : null;
}

// ---- (1) video: field + image: poster -> both coexist, image is the poster ----
{
  const section = makeSection();
  const slot = makeEl('img', { src: 'https://otratickets.com/uploads/design-default.jpg', className: '', section });
  const res = await runScenario({
    fields: {
      'video:#evVideoImg': { type: 'image', value: '/override-images/x/clip.mp4' },
      'image:#evVideoImg': { type: 'image', value: '/override-images/x/poster.webp' },
    },
    selectors: { '#evVideoImg': slot },
  });
  const video = insertedVideo(slot);
  assert(video, '(1) expected a <video> to be inserted for the video: field');
  assert(video && /clip\.mp4$/.test(video.src), '(1) video src should be the uploaded clip, got ' + (video && video.src));
  assert(video && /poster\.webp$/.test(video.poster), '(1) poster should be the uploaded image, got ' + (video && video.poster));
  assert(slot.style.display === 'none', '(1) original slot img should be hidden');
  assert(section._classes.has('is-live'), '(1) .ev-video should be marked is-live');
  assert(res.createdVideos.length === 1, '(1) exactly one <video> should be created, got ' + res.createdVideos.length);

  // Idempotent: re-applying on event-rendered must not add a second player.
  await res.dispatch('otra:event-rendered');
  assert(res.createdVideos.length === 1, '(1) re-apply must not create a second <video>, got ' + res.createdVideos.length);
}

// ---- (2) video: field, no poster image -> falls back to the slot's current src ----
{
  const section = makeSection();
  const slot = makeEl('img', { src: 'https://otratickets.com/uploads/design-default.jpg', section });
  await runScenario({
    fields: { 'video:#evVideoImg': { type: 'image', value: '/override-images/x/clip.mp4' } },
    selectors: { '#evVideoImg': slot },
  });
  const video = insertedVideo(slot);
  assert(video, '(2) expected a <video> to be inserted');
  assert(video && /design-default\.jpg$/.test(video.poster), '(2) poster should fall back to the slot image, got ' + (video && video.poster));
}

// ---- (3) legacy: a video value stored in an image: field still swaps in a player ----
{
  const section = makeSection();
  const slot = makeEl('img', { src: 'https://otratickets.com/uploads/design-default.jpg', section });
  const res = await runScenario({
    fields: { 'image:#evVideoImg': { type: 'image', value: '/override-images/x/legacy.mp4' } },
    selectors: { '#evVideoImg': slot },
  });
  const video = insertedVideo(slot);
  assert(video, '(3) legacy video-in-image should still swap to a <video>');
  assert(video && /legacy\.mp4$/.test(video.src), '(3) legacy video src, got ' + (video && video.src));
  assert(res.createdVideos.length === 1, '(3) exactly one <video>, got ' + res.createdVideos.length);
}

// ---- (4) a plain still image in an image: field is applied as an image, no <video> ----
{
  const slot = makeEl('img', { src: 'https://otratickets.com/uploads/old.jpg' });
  const res = await runScenario({
    fields: { 'image:#evHeroImg': { type: 'image', value: '/override-images/x/photo.jpg' } },
    selectors: { '#evHeroImg': slot },
  });
  assert(res.createdVideos.length === 0, '(4) a still image must not create a <video>');
  assert(/photo\.jpg$/.test(slot.src), '(4) image slot src should become the uploaded image, got ' + slot.src);
}

// ---- (5) text: and remove: fields the new logic sits beside still work ----
{
  const title = makeEl('div', { });
  title.textContent = 'Old';
  const gone = makeEl('div', {});
  await runScenario({
    fields: {
      'text:.t': { type: 'text', value: 'New' },
      'remove:.r': { type: 'remove' },
    },
    selectors: { '.t': title, '.r': gone },
  });
  assert(title.textContent === 'New', '(5) text field should update textContent, got ' + title.textContent);
  assert((gone._removed || 0) === 1, '(5) remove field should remove the element, got ' + (gone._removed || 0));
}

if (failures.length) {
  console.error('check-video-poster FAILED:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('check-video-poster OK (video+poster coexist, legacy swap, image-only, text/remove, idempotent)');
