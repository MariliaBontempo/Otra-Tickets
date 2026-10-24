// Oracle: a page created without photos must still give the editor an upload
// pencil on the hero image, the feature photo/video and the photo band. The
// editor reveals those empty slots as placeholders (never as removable
// sections), and a photo or video saved for one of them makes the hidden
// section show on the page.
// Run: node scripts/check-admin-empty-image-slots.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const overrides = fs.readFileSync(new URL('../site-overrides.js', import.meta.url), 'utf8');
const eventHtml = fs.readFileSync(new URL('../event.html', import.meta.url), 'utf8');
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function extractFunction(name, source = html) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

function extractConst(name, source = html) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[[\\s\\S]*?\\];`));
  return match ? match[0] : '';
}

for (const id of ['evHeroImg', 'evVideoImg', 'evPhotoBandImg', 'evVideoSection', 'evPhotoBandSection']) {
  assert(eventHtml.includes(`id="${id}"`), `event.html must still have #${id}`);
}

const slotsSource = extractConst('EMPTY_IMAGE_SLOTS');
const revealSource = extractFunction('revealEmptyImageSlots');
const editableSource = extractFunction('isEditableImage');
const removableSource = extractFunction('isRemovableSection');
const injectSource = extractFunction('injectEditControls');
const revealSectionSource = extractFunction('revealSlotSection', overrides);
assert(slotsSource, 'EMPTY_IMAGE_SLOTS must exist');
assert(revealSource, 'revealEmptyImageSlots must exist');
assert(revealSectionSource, 'site-overrides.js revealSlotSection must exist');
assert(
  injectSource.indexOf('revealEmptyImageSlots(doc)') > -1 &&
    injectSource.indexOf('revealEmptyImageSlots(doc)') < injectSource.indexOf('const fields = candidateElements(doc)'),
  'injectEditControls must reveal empty slots before collecting pencils'
);
for (const id of ['#evHeroImg', '#evVideoImg', '#evPhotoBandImg']) {
  assert(slotsSource.includes(`"${id}"`), `EMPTY_IMAGE_SLOTS must cover ${id}`);
}
assert(/revealSlotSection\(el, !isVideoUrl\(field\.value\)\)/.test(overrides), 'image overrides must reveal their slot section');
assert(/applyVideoOverride\(el, field\.value, poster\);\s*revealSlotSection\(el, false\)/.test(overrides), 'video overrides must reveal their slot section');

class FakeClassList {
  constructor(names) { this.set = new Set(names); }
  contains(name) { return this.set.has(name); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
}

class FakeEl {
  constructor(tagName, { id = '', classes = [], hidden = false, attrs = {} } = {}) {
    this.tagName = tagName;
    this.id = id;
    this.classList = new FakeClassList(classes);
    this.hidden = hidden;
    this.attrs = { ...attrs };
    this.dataset = {};
    this.parentElement = null;
    this.currentSrc = '';
    this.style = { backgroundImage: '' };
  }
  append(child) { child.parentElement = this; return child; }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  hasAttribute(name) { return name in this.attrs; }
  matches(selector) {
    return selector.split(',').map((s) => s.trim()).some((s) =>
      (s.startsWith('#') && this.id === s.slice(1)) ||
      (s === this.tagName.toLowerCase()) ||
      (s.startsWith('.') && this.classList.contains(s.slice(1))));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  getBoundingClientRect() { return { width: 100, height: 100 }; }
}

function makeDoc({ heroSrc = '', videoSrc = '', videoOverride = '' } = {}) {
  const main = new FakeEl('MAIN');
  const hero = main.append(new FakeEl('SECTION', { classes: ['ev-hero'] }));
  const heroImg = hero.append(new FakeEl('IMG', { id: 'evHeroImg', classes: ['ev-hero-img'], attrs: heroSrc ? { src: heroSrc } : {} }));
  const video = main.append(new FakeEl('SECTION', { id: 'evVideoSection', classes: ['ev-video', 'reveal'], hidden: !videoSrc }));
  const videoImg = video.append(new FakeEl('IMG', { id: 'evVideoImg', attrs: videoSrc ? { src: videoSrc } : {} }));
  if (videoOverride) videoImg.dataset.otraVideo = videoOverride;
  const band = main.append(new FakeEl('SECTION', { id: 'evPhotoBandSection', classes: ['ev-photoband', 'reveal'], hidden: true }));
  const bandImg = band.append(new FakeEl('IMG', { id: 'evPhotoBandImg' }));
  const all = [main, hero, heroImg, video, videoImg, band, bandImg];
  const doc = {
    querySelector: (selector) => all.find((el) => el.matches(selector)) || null,
    defaultView: { getComputedStyle: (el) => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible', backgroundImage: 'none' }) },
  };
  for (const el of all) el.ownerDocument = doc;
  return { doc, hero, heroImg, video, videoImg, band, bandImg };
}

const context = {
  getComputedStyle: () => ({ backgroundImage: 'none' }),
};
vm.createContext(context);
vm.runInContext(`${slotsSource}\n${revealSource}\n${editableSource}\n${removableSource}\n${revealSectionSource}\nthis.api = { revealEmptyImageSlots, isEditableImage, isRemovableSection, revealSlotSection };`, context);
const { revealEmptyImageSlots, isEditableImage, isRemovableSection, revealSlotSection } = context.api;

// 1) Strange Bird style draft: no photos anywhere.
{
  const d = makeDoc();
  assert(!isEditableImage(d.heroImg), 'precondition: an empty hero is not editable before reveal');
  const revealed = revealEmptyImageSlots(d.doc);
  assert(revealed.length === 3, `all three empty slots must be revealed, got ${revealed.length}`);
  for (const [name, img] of [['hero', d.heroImg], ['feature', d.videoImg], ['photo band', d.bandImg]]) {
    assert(isEditableImage(img), `empty ${name} image must get an upload pencil`);
  }
  assert(!d.video.hidden, 'empty feature photo/video section must be shown in the editor');
  assert(!d.band.hidden, 'empty photo band section must be shown in the editor');
  assert(d.video.classList.contains('is-image'), 'empty feature slot must hide the decorative play overlay');
  assert(/Click the pencil to upload/.test(d.video.getAttribute('data-otra-empty-slot-label') || ''), 'empty feature slot must say how to upload');
  assert(/Click the pencil to upload/.test(d.hero.getAttribute('data-otra-empty-slot-label') || ''), 'empty hero must say how to upload');
  assert(!isRemovableSection(d.video), 'a revealed empty slot must not get a Remove section button');
  assert(!isRemovableSection(d.band), 'a revealed empty photo band must not get a Remove section button');
  // Running again (the editor re-injects every 250 ms) stays stable.
  revealEmptyImageSlots(d.doc);
  assert(isEditableImage(d.videoImg) && !d.video.hidden, 'reveal must be idempotent');
}

// 2) Slots that already have media are left alone.
{
  const d = makeDoc({ heroSrc: '/photos/hero.jpg', videoSrc: '/photos/feature.jpg' });
  const revealed = revealEmptyImageSlots(d.doc);
  assert(!revealed.includes('#evHeroImg') && !revealed.includes('#evVideoImg'), 'filled slots must not be marked empty');
  assert(!d.heroImg.hasAttribute('data-otra-empty-slot'), 'a filled hero keeps no placeholder');
  assert(isRemovableSection(d.video), 'a real filled feature section keeps its Remove button');
}

// 3) A video override counts as media.
{
  const d = makeDoc({ videoOverride: 'https://example.com/clip.mp4' });
  revealEmptyImageSlots(d.doc);
  assert(!d.videoImg.hasAttribute('data-otra-empty-slot'), 'a slot playing an uploaded video is not empty');
}

// 4) Once the page fills a slot after the first pass, the placeholder goes away.
{
  const d = makeDoc();
  revealEmptyImageSlots(d.doc);
  d.heroImg.setAttribute('src', '/photos/late.jpg');
  revealEmptyImageSlots(d.doc);
  assert(!d.heroImg.hasAttribute('data-otra-empty-slot'), 'hero placeholder must clear once an image loads');
  assert(!d.hero.hasAttribute('data-otra-empty-slot-label'), 'hero label must clear once an image loads');
}

// 5) Public page: a saved photo/video for an empty slot shows its section.
{
  const d = makeDoc();
  revealSlotSection(d.videoImg, true);
  assert(!d.video.hidden && d.video.classList.contains('is-image'), 'saved feature photo must show the section as an image');
  revealSlotSection(d.bandImg, true);
  assert(!d.band.hidden, 'saved photo band image must show its section');
  const v = makeDoc();
  revealSlotSection(v.videoImg, false);
  assert(!v.video.hidden && !v.video.classList.contains('is-image'), 'saved feature video must show the section without forcing image mode');
  const h = makeDoc({ heroSrc: '/x.jpg' });
  revealSlotSection(h.heroImg, true);
  assert(h.video.hidden, 'a hero override must not reveal unrelated sections');
}

if (failures.length) {
  console.error('FAIL check-admin-empty-image-slots');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('PASS check-admin-empty-image-slots');
