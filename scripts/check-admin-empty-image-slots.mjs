// Oracle: a page created without photos must still give the editor an upload
// pencil on all five image slots: hero image, story image, feature
// photo/video, appreciation band background and photo band. The
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

for (const id of ['evHeroImg', 'evStoryImg', 'story', 'evVideoImg', 'evVideoSection', 'evBandBg', 'evBandSection', 'evPhotoBandImg', 'evPhotoBandSection']) {
  assert(eventHtml.includes(`id="${id}"`), `event.html must still have #${id}`);
}

const slotsSource = extractConst('EMPTY_IMAGE_SLOTS');
const revealSource = extractFunction('revealEmptyImageSlots');
const hasMediaSource = extractFunction('slotHasMedia');
assert(hasMediaSource, 'slotHasMedia must exist');
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
for (const id of ['#evHeroImg', '#evStoryImg', '#evVideoImg', '#evBandBg', '#evPhotoBandImg']) {
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
    this.style = { backgroundImage: '', gridTemplateColumns: '' };
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

function makeDoc({ heroSrc = '', videoSrc = '', videoOverride = '', storyText = false, bandBg = '', bandText = false } = {}) {
  const main = new FakeEl('MAIN');
  const hero = main.append(new FakeEl('SECTION', { classes: ['ev-hero'] }));
  const heroImg = hero.append(new FakeEl('IMG', { id: 'evHeroImg', classes: ['ev-hero-img'], attrs: heroSrc ? { src: heroSrc } : {} }));
  // event.html: story is shown only with a description; without a photo the
  // image stays hidden and the text spans the full width.
  const story = main.append(new FakeEl('SECTION', { id: 'story', classes: ['ev-story', 'reveal'], hidden: !storyText }));
  if (storyText) story.style.gridTemplateColumns = '1fr';
  const storyImg = story.append(new FakeEl('IMG', { id: 'evStoryImg', classes: ['ev-story-img'], hidden: true }));
  const band = main.append(new FakeEl('SECTION', { id: 'evBandSection', classes: ['ev-band', 'reveal'], hidden: !(bandBg || bandText) }));
  const bandBgEl = band.append(new FakeEl('DIV', { id: 'evBandBg', classes: ['ev-band-bg'] }));
  if (bandBg) bandBgEl.style.backgroundImage = `url("${bandBg}")`;
  const video = main.append(new FakeEl('SECTION', { id: 'evVideoSection', classes: ['ev-video', 'reveal'], hidden: !videoSrc }));
  const videoImg = video.append(new FakeEl('IMG', { id: 'evVideoImg', attrs: videoSrc ? { src: videoSrc } : {} }));
  if (videoOverride) videoImg.dataset.otraVideo = videoOverride;
  const photoBand = main.append(new FakeEl('SECTION', { id: 'evPhotoBandSection', classes: ['ev-photoband', 'reveal'], hidden: true }));
  const bandImg = photoBand.append(new FakeEl('IMG', { id: 'evPhotoBandImg' }));
  const all = [main, hero, heroImg, story, storyImg, band, bandBgEl, video, videoImg, photoBand, bandImg];
  const doc = {
    querySelector: (selector) => all.find((el) => el.matches(selector)) || null,
    defaultView: { getComputedStyle: (el) => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible', backgroundImage: el.style.backgroundImage || 'none' }) },
  };
  for (const el of all) el.ownerDocument = doc;
  return { doc, hero, heroImg, story, storyImg, band, bandBg: bandBgEl, video, videoImg, photoBand, bandImg };
}

const context = {
  getComputedStyle: () => ({ backgroundImage: 'none' }),
};
vm.createContext(context);
vm.runInContext(`${slotsSource}\n${hasMediaSource}\n${revealSource}\n${editableSource}\n${removableSource}\n${revealSectionSource}\nthis.api = { revealEmptyImageSlots, isEditableImage, isRemovableSection, revealSlotSection };`, context);
const { revealEmptyImageSlots, isEditableImage, isRemovableSection, revealSlotSection } = context.api;

// 1) Strange Bird style draft: no photos anywhere.
{
  const d = makeDoc();
  assert(!isEditableImage(d.heroImg), 'precondition: an empty hero is not editable before reveal');
  const revealed = revealEmptyImageSlots(d.doc);
  assert(revealed.length === 5, `all five empty slots must be revealed, got ${revealed.length}`);
  for (const [name, img] of [['hero', d.heroImg], ['story', d.storyImg], ['feature', d.videoImg], ['band background', d.bandBg], ['photo band', d.bandImg]]) {
    assert(isEditableImage(img), `empty ${name} image must get an upload pencil`);
  }
  for (const sec of [d.video, d.photoBand, d.story, d.band]) {
    assert(sec.hasAttribute('data-otra-empty-placeholder'), `empty ${sec.id} must be marked so the editor CSS shows it`);
    assert(sec.hidden, `${sec.id}: the editor must not flip section.hidden, the template owns it`);
  }
  assert(d.storyImg.hidden, 'the editor must not flip the story image hidden flag, CSS shows it');
  assert(/Click the pencil to upload/.test(d.band.getAttribute('data-otra-empty-slot-label') || ''), 'empty band background must say how to upload');
  assert(d.band.hasAttribute('data-otra-empty-slot-top'), 'band label must sit at the top so it does not cover band text');
  assert(!isRemovableSection(d.story), 'a story revealed only for its empty photo must not get a Remove section button');
  assert(d.video.classList.contains('is-image'), 'empty feature slot must hide the decorative play overlay');
  assert(/Click the pencil to upload/.test(d.video.getAttribute('data-otra-empty-slot-label') || ''), 'empty feature slot must say how to upload');
  assert(/Click the pencil to upload/.test(d.hero.getAttribute('data-otra-empty-slot-label') || ''), 'empty hero must say how to upload');
  assert(!isRemovableSection(d.video), 'a revealed empty slot must not get a Remove section button');
  assert(!isRemovableSection(d.photoBand), 'a revealed empty photo band must not get a Remove section button');
  assert(!isRemovableSection(d.band), 'a band revealed only for its empty background must not get a Remove section button');
  // Running again (the editor re-injects every 250 ms) stays stable.
  revealEmptyImageSlots(d.doc);
  assert(isEditableImage(d.videoImg) && d.video.hasAttribute('data-otra-empty-placeholder'), 'reveal must be idempotent');
}

// 2) Slots that already have media are left alone.
{
  const d = makeDoc({ heroSrc: '/photos/hero.jpg', videoSrc: '/photos/feature.jpg' });
  const revealed = revealEmptyImageSlots(d.doc);
  assert(!revealed.includes('#evHeroImg') && !revealed.includes('#evVideoImg'), 'filled slots must not be marked empty');
  assert(!d.heroImg.hasAttribute('data-otra-empty-slot'), 'a filled hero keeps no placeholder');
  assert(isRemovableSection(d.video), 'a real filled feature section keeps its Remove button');
}

// 2b) Story with text but no photo: the photo column comes back in the editor.
{
  const d = makeDoc({ storyText: true, bandText: true });
  revealEmptyImageSlots(d.doc);
  assert(isEditableImage(d.storyImg), 'story with text and no photo must get a photo pencil');
  assert(d.story.style.gridTemplateColumns === '', 'story must get its photo column back for the empty slot');
  assert(!d.story.hidden, 'a story that already had text stays a real visible section');
  assert(isRemovableSection(d.story), 'a story that already had text keeps its Remove button');
  assert(isEditableImage(d.bandBg), 'band with text and no background must get a background pencil');
  assert(isRemovableSection(d.band), 'a band that already had text keeps its Remove button');
}

// 2c) A band background that already has an image is left alone.
{
  const d = makeDoc({ bandBg: '/photos/band.jpg' });
  const revealed = revealEmptyImageSlots(d.doc);
  assert(!revealed.includes('#evBandBg') && !d.bandBg.hasAttribute('data-otra-empty-slot'), 'a filled band background must not be marked empty');
}

// 2d) Early pass before render: sections revealed while empty become real,
// removable sections once render fills them.
{
  const d = makeDoc();
  revealEmptyImageSlots(d.doc);
  for (const sec of [d.story, d.band, d.video, d.photoBand]) {
    assert(sec.hasAttribute('data-otra-empty-placeholder') && !isRemovableSection(sec), `precondition: ${sec.id} is a placeholder on the early pass`);
  }
  d.storyImg.setAttribute('src', '/photos/story.jpg'); d.storyImg.hidden = false; d.story.hidden = false;
  d.bandBg.style.backgroundImage = 'url("/photos/band.jpg")'; d.band.hidden = false;
  d.videoImg.setAttribute('src', '/photos/feature.jpg'); d.video.hidden = false;
  d.bandImg.setAttribute('src', '/photos/photoband.jpg'); d.photoBand.hidden = false;
  d.heroImg.setAttribute('src', '/photos/hero.jpg');
  revealEmptyImageSlots(d.doc);
  for (const sec of [d.story, d.band, d.video, d.photoBand]) {
    assert(!sec.hasAttribute('data-otra-empty-placeholder'), `${sec.id} must drop the placeholder marker once media loads`);
    assert(!sec.hasAttribute('data-otra-empty-slot-label'), `${sec.id} must drop the empty label once media loads`);
    assert(isRemovableSection(sec), `${sec.id} must get its Remove section button back once media loads`);
  }
  assert(!d.storyImg.hasAttribute('data-otra-empty-slot'), 'story image marker must clear once media loads');
}

// 2e) Early pass before render, then a text only render (story body, band
// title) with still no photo: the sections are real and keep Remove, while
// their empty photo slots keep their pencils.
{
  const d = makeDoc();
  revealEmptyImageSlots(d.doc);
  assert(!isRemovableSection(d.story) && !isRemovableSection(d.band), 'precondition: early placeholders have no Remove button');
  d.story.hidden = false; d.story.style.gridTemplateColumns = '1fr';
  d.band.hidden = false;
  revealEmptyImageSlots(d.doc);
  assert(isRemovableSection(d.story), 'story rendered with text and no photo must get its Remove section button');
  assert(isRemovableSection(d.band), 'band rendered with a title and no background must get its Remove section button');
  assert(isEditableImage(d.storyImg) && isEditableImage(d.bandBg), 'empty story photo and band background keep their pencils after a text only render');
  assert(d.story.style.gridTemplateColumns === '', 'story photo column must come back after a text only render');
  assert(!isRemovableSection(d.video) && !isRemovableSection(d.photoBand), 'still template hidden placeholders stay without Remove');
}

// 2f) Editor CSS shows template hidden placeholders with the right display.
{
  for (const [sel, disp] of [['section#story', 'grid'], ['section#evBandSection', 'flex'], ['section#evVideoSection', 'block'], ['section#evPhotoBandSection', 'block']]) {
    const re = new RegExp(sel.replace(/[#]/g, '\\#') + '\\[hidden\\]\\[data-otra-empty-placeholder\\][^{]*\\{\\s*display:\\s*' + disp + ' !important');
    assert(re.test(html), `editor CSS must show a hidden ${sel} placeholder as ${disp}`);
  }
  assert(/img\[hidden\]\[data-otra-empty-slot\][^{]*\{\s*display: block !important/.test(html), 'editor CSS must show a hidden empty story image');
  assert(!/data-otra-empty-revealed/.test(html), 'the sticky revealed flag must be gone');
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
  assert(!d.photoBand.hidden, 'saved photo band image must show its section');
  revealSlotSection(d.storyImg, true);
  assert(!d.story.hidden && !d.storyImg.hidden, 'saved story photo must show the story image');
  revealSlotSection(d.bandBg, true);
  assert(!d.band.hidden, 'saved band background must show the band');
  const t = makeDoc({ storyText: true });
  revealSlotSection(t.storyImg, true);
  assert(t.story.style.gridTemplateColumns === '', 'saved story photo must restore the two column story layout');
  const u = makeDoc();
  assert(u.band.hidden && u.story.hidden, 'precondition: without overrides band and story stay hidden on the public page');
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
