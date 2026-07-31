// Oracle: verifies site-overrides.js is idempotent.
// Run: node scripts/check-overrides-idempotent.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { URL, URLSearchParams } from 'node:url';

const SOURCE = fs.readFileSync(new URL('../site-overrides.js', import.meta.url), 'utf8');

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

async function flush() {
  return new Promise(r => setImmediate(r));
}

function makeEl(tagName, init) {
  init = init || {};
  const counts = {};
  const children = [];
  const state = {
    textContent: init.textContent || '',
    src: init.src || '',
    poster: init.poster || '',
    className: init.className || '',
    innerHTML: '',
  };
  const styleState = {
    background: init.background || '',
    backgroundColor: init.backgroundColor || '',
    backgroundImage: init.backgroundImage || '',
    marginTop: '',
    whiteSpace: '',
  };
  const style = {
    get background() { return styleState.background; },
    set background(v) { styleState.background = v; },
    get backgroundColor() { return styleState.backgroundColor; },
    set backgroundColor(v) { styleState.backgroundColor = v; },
    get backgroundImage() { return styleState.backgroundImage; },
    set backgroundImage(v) {
      counts.backgroundImage = (counts.backgroundImage || 0) + 1;
      styleState.backgroundImage = v;
    },
    get marginTop() { return styleState.marginTop; },
    set marginTop(v) { styleState.marginTop = v; },
    set whiteSpace(v) { styleState.whiteSpace = v; },
    getPropertyValue(prop) {
      if (prop === 'background') return styleState.background || '';
      if (prop === 'background-color') return styleState.backgroundColor || '';
      if (prop === 'background-image') return styleState.backgroundImage || '';
      return '';
    },
    getPropertyPriority(prop) {
      return styleState[prop + 'Priority'] || '';
    },
    setProperty(prop, value, priority) {
      counts['set:' + prop] = (counts['set:' + prop] || 0) + 1;
      if (prop === 'background') {
        styleState.background = value;
      }
      if (prop === 'background-color') styleState.backgroundColor = value;
      if (prop === 'background-image') styleState.backgroundImage = value;
      styleState[prop + 'Priority'] = priority || '';
    },
    removeProperty(prop) {
      counts['remove:' + prop] = (counts['remove:' + prop] || 0) + 1;
      if (prop === 'background') styleState.background = '';
      if (prop === 'background-color') styleState.backgroundColor = '';
      if (prop === 'background-image') styleState.backgroundImage = '';
    },
  };
  const el = {
    tagName: tagName.toUpperCase(),
    get textContent() { return state.textContent; },
    set textContent(v) { counts.textContent = (counts.textContent || 0) + 1; state.textContent = v; },
    get className() { return state.className; },
    set className(v) { state.className = v; },
    classList: {
      contains(name) { return state.className.split(/\s+/).includes(name); },
      add(name) {
        if (!this.contains(name)) state.className = (state.className + ' ' + name).trim();
      },
      remove(name) {
        state.className = state.className
          .split(/\s+/)
          .filter((item) => item && item !== name)
          .join(' ');
      },
    },
    dataset: {},
    get innerHTML() { return state.innerHTML; },
    set innerHTML(v) {
      counts.innerHTML = (counts.innerHTML || 0) + 1;
      state.innerHTML = v;
      if (v === '') children.splice(0);
    },
    get src() { return state.src; },
    set src(v) { counts.src = (counts.src || 0) + 1; state.src = v; },
    get poster() { return state.poster; },
    set poster(v) { counts.poster = (counts.poster || 0) + 1; state.poster = v; },
    style,
    children,
    appendChild(child) {
      counts.appendChild = (counts.appendChild || 0) + 1;
      child.parentElement = el;
      children.push(child);
      return child;
    },
    querySelector(selector) {
      if (selector === '.k') {
        return children.find((child) => child.classList && child.classList.contains('k')) || null;
      }
      if (selector === '.v') {
        return children.find((child) => child.classList && child.classList.contains('v')) || null;
      }
      if (selector === '.k[data-otra-info-title]') {
        return children.find((child) =>
          child.classList &&
          child.classList.contains('k') &&
          child.dataset &&
          child.dataset.otraInfoTitle
        ) || null;
      }
      if (selector === '.v[data-otra-info-subtitle]') {
        return children.find((child) =>
          child.classList &&
          child.classList.contains('v') &&
          child.dataset &&
          child.dataset.otraInfoSubtitle
        ) || null;
      }
      return null;
    },
    closest(selector) {
      let current = el;
      while (current) {
        if (selector === '.ev-info-cell' && current.classList?.contains('ev-info-cell')) return current;
        current = current.parentElement;
      }
      return null;
    },
    remove() { counts.removed = (counts.removed || 0) + 1; },
    counts,
  };
  return el;
}

async function runScenario(opts) {
  const { fields, accentColor, selectors, computedAccent } = opts;
  const timerQueue = [];
  const listeners = {};
  let timerCount = 0;
  let setPropertyCalls = 0;

  const docEl = {
    style: {
      setProperty(prop) {
        if (prop === '--accent') setPropertyCalls++;
      }
    }
  };

  const sandbox = {
    document: {
      currentScript: { dataset: { overrideId: '6113' } },
      documentElement: docEl,
      querySelector(sel) {
        return (sel in selectors) ? selectors[sel] : null;
      },
      querySelectorAll(sel) {
        const parts = sel.split(',').map(function(s) { return s.trim(); });
        const found = [];
        for (const p of parts) {
          if ((p in selectors) && selectors[p]) found.push(selectors[p]);
        }
        return { forEach: function(fn) { found.forEach(fn); } };
      },
      addEventListener(type, fn) {
        (listeners[type] || (listeners[type] = [])).push(fn);
      },
      createElement(tag) {
        return makeEl(tag, {});
      }
    },
    location: {
      search: '',
      pathname: '/clearboat',
      href: 'https://otratickets.com/clearboat'
    },
    fetch: function(url, opts) {
      return Promise.resolve({
        ok: true,
        json: function() {
          return Promise.resolve({
            override: { accentColor: accentColor || null, fields: fields || {} }
          });
        }
      });
    },
    getComputedStyle: function() {
      return {
        getPropertyValue: function(prop) {
          return prop === '--accent' ? (computedAccent || '#ffffff') : '';
        }
      };
    },
    Image: class {
      constructor() { this._src = ''; }
      get src() { return this._src; }
      set src(v) { this._src = v; }
      decode() { return Promise.resolve(); }
    },
    URL,
    URLSearchParams,
    setTimeout: function(cb) {
      timerCount++;
      timerQueue.push(cb);
    }
  };

  vm.runInNewContext(SOURCE, sandbox);

  for (let i = 0; i < 6; i++) await flush();

  let timerRounds = 0;
  while (timerQueue.length > 0 && timerRounds < 45) {
    const cbs = timerQueue.splice(0);
    for (const cb of cbs) {
      cb();
      for (let i = 0; i < 3; i++) await flush();
    }
    timerRounds++;
  }

  for (let i = 0; i < 3; i++) await flush();

  return {
    timerCount,
    setPropertyCalls,
    async dispatch(type) {
      for (const fn of listeners[type] || []) {
        fn({ type });
        for (let i = 0; i < 3; i++) await flush();
      }
    }
  };
}

const BASE_HREF = 'https://otratickets.com/clearboat';

// ---- Scenario (a): all elements present, values differ ----
{
  const aTitle = makeEl('div', { textContent: 'Old Title' });
  const aImg = makeEl('img', { src: new URL('/uploads/old.jpg', BASE_HREF).href });
  const aBg = makeEl('div', { backgroundImage: '' });
  const aVideo = makeEl('video', { poster: new URL('/uploads/old-poster.jpg', BASE_HREF).href });
  const aRemove = makeEl('div', {});

  const result = await runScenario({
    fields: {
      'text:.a-title': { type: 'text', value: 'New Title' },
      'image:.a-img': { type: 'image', value: '/uploads/new.jpg' },
      'image:.a-bg': { type: 'image', value: '/uploads/bg.jpg' },
      'image:.a-video': { type: 'image', value: '/uploads/poster.jpg' },
      'remove:.a-remove': { type: 'remove' },
    },
    selectors: {
      '.a-title': aTitle,
      '.a-img': aImg,
      '.a-bg': aBg,
      '.a-video': aVideo,
      '.a-remove': aRemove,
    },
  });

  assert(
    (aTitle.counts.textContent || 0) === 1,
    '(a) text: expected 1 set, got ' + (aTitle.counts.textContent || 0)
  );
  assert(
    (aImg.counts.src || 0) === 1,
    '(a) img src: expected 1 set, got ' + (aImg.counts.src || 0)
  );
  assert(
    (aBg.counts.backgroundImage || 0) === 1,
    '(a) backgroundImage: expected 1 set, got ' + (aBg.counts.backgroundImage || 0)
  );
  assert(
    (aVideo.counts.poster || 0) === 1,
    '(a) video poster: expected 1 set, got ' + (aVideo.counts.poster || 0)
  );
  assert(
    (aRemove.counts.removed || 0) === 1,
    '(a) remove: expected 1 remove call, got ' + (aRemove.counts.removed || 0)
  );
  assert(
    result.timerCount === 0,
    '(a) expected 0 retry timers after full apply, got ' + result.timerCount
  );
}

// ---- Scenario (b): all values already equal to DOM ----
{
  const bTitle = makeEl('div', { textContent: 'New Title' });
  const bImg = makeEl('img', { src: new URL('/uploads/new.jpg', BASE_HREF).href });
  const bgStr = 'url("/uploads/bg.jpg")';
  const bBg = makeEl('div', { backgroundImage: bgStr });
  const bVideo = makeEl('video', { poster: new URL('/uploads/poster.jpg', BASE_HREF).href });

  const result = await runScenario({
    fields: {
      'text:.b-title': { type: 'text', value: 'New Title' },
      'image:.b-img': { type: 'image', value: '/uploads/new.jpg' },
      'image:.b-bg': { type: 'image', value: '/uploads/bg.jpg' },
      'image:.b-video': { type: 'image', value: '/uploads/poster.jpg' },
    },
    selectors: {
      '.b-title': bTitle,
      '.b-img': bImg,
      '.b-bg': bBg,
      '.b-video': bVideo,
    },
  });

  assert(
    (bTitle.counts.textContent || 0) === 0,
    '(b) text already equal: expected 0 sets, got ' + (bTitle.counts.textContent || 0)
  );
  assert(
    (bImg.counts.src || 0) === 0,
    '(b) img src already equal: expected 0 sets, got ' + (bImg.counts.src || 0)
  );
  assert(
    (bBg.counts.backgroundImage || 0) === 0,
    '(b) backgroundImage already equal: expected 0 sets, got ' + (bBg.counts.backgroundImage || 0)
  );
  assert(
    (bVideo.counts.poster || 0) === 0,
    '(b) video poster already equal: expected 0 sets, got ' + (bVideo.counts.poster || 0)
  );
  assert(
    result.timerCount === 0,
    '(b) expected 0 retry timers, got ' + result.timerCount
  );
}

// ---- Scenario (c): one selector never matches; ceiling reached ----
{
  const cFound = makeEl('div', { textContent: 'Old' });

  const result = await runScenario({
    fields: {
      'text:.c-found': { type: 'text', value: 'New' },
      'text:.c-never': { type: 'text', value: 'Never' },
    },
    selectors: {
      '.c-found': cFound,
      // .c-never is intentionally absent - querySelector returns null
    },
  });

  assert(
    (cFound.counts.textContent || 0) === 1,
    '(c) found element: expected 1 text set, got ' + (cFound.counts.textContent || 0)
  );
  assert(
    result.timerCount === 30,
    '(c) expected 30 retry timers (ceiling), got ' + result.timerCount
  );
}

// ---- Scenario (d): --accent guard ----
{
  // d1: accent already matches computed - no setProperty
  const d1 = await runScenario({
    fields: {},
    accentColor: '#ff0000',
    computedAccent: '#ff0000',
    selectors: {},
  });
  assert(
    d1.setPropertyCalls === 0,
    '(d1) accent matches: expected 0 setProperty calls, got ' + d1.setPropertyCalls
  );

  // d2: accent differs from computed - one setProperty
  const d2 = await runScenario({
    fields: {},
    accentColor: '#ff0000',
    computedAccent: '#ffffff',
    selectors: {},
  });
  assert(
    d2.setPropertyCalls === 1,
    '(d2) accent differs: expected 1 setProperty call, got ' + d2.setPropertyCalls
  );
}

// ---- Scenario (e): empty fields ----
{
  const result = await runScenario({
    fields: {},
    selectors: {},
  });
  assert(
    result.timerCount === 0,
    '(e) empty fields: expected 0 timers, got ' + result.timerCount
  );
  assert(
    result.setPropertyCalls === 0,
    '(e) empty fields: expected 0 mutations, got ' + result.setPropertyCalls
  );
}

// ---- Scenario (f): dynamic event render overwrites early field apply ----
{
  const fTitle = makeEl('h1', { textContent: '' });

  const result = await runScenario({
    fields: {
      'text:#evTitle': { type: 'text', value: 'Edited Preview Title' },
    },
    selectors: {
      '#evTitle': fTitle,
    },
  });

  assert(
    fTitle.textContent === 'Edited Preview Title',
    '(f) initial dynamic field apply: expected edited title, got ' + fTitle.textContent
  );

  fTitle.textContent = 'API Rendered Title';
  await result.dispatch('otra:event-rendered');

  assert(
    fTitle.textContent === 'Edited Preview Title',
    '(f) dynamic render event: expected edited title after reapply, got ' + fTitle.textContent
  );
}

// ---- Scenario (g): an empty decorative info cell becomes editable content ----
{
  const gCell = makeEl('div', {
    className: 'ev-info-cell',
    background: '#f2b544',
    backgroundColor: 'rgb(242, 181, 68)',
    backgroundImage: 'linear-gradient(#f2b544, #e89920)',
  });

  const gFields = {
    'text:.g-info': {
      type: 'text',
      value: 'otra-info-cell:{"title":"Requirements","subtitle":"Bring a valid driver’s license"}',
    },
  };
  const result = await runScenario({
    fields: gFields,
    selectors: {
      '.g-info': gCell,
    },
  });

  assert(gCell.children.length === 2, '(g) empty info cell must create title and subtitle elements');
  const title = gCell.children[0];
  const subtitle = gCell.children[1];
  assert(title?.classList.contains('k'), '(g) generated title must use the existing .k styling');
  assert(title?.dataset.otraInfoTitle === '1', '(g) generated title must be identifiable on reapply');
  assert(title?.textContent === 'Requirements', '(g) generated title must contain the title override');
  assert(subtitle?.classList.contains('v'), '(g) generated subtitle must use the existing .v styling');
  assert(subtitle?.dataset.otraInfoSubtitle === '1', '(g) generated subtitle must be identifiable on reapply');
  assert(subtitle?.textContent === 'Bring a valid driver’s license', '(g) generated subtitle must contain the subtitle override');
  assert(subtitle?.style.marginTop === '', '(g) title + subtitle must retain the standard .v spacing');
  assert(gCell.counts['remove:background-color'] === 1, '(g) decorative background colour must be removed');
  assert(gCell.counts['remove:background-image'] === 1, '(g) decorative background image must be removed');
  assert(gCell.style.background === 'var(--ink, #11151b)', '(g) info cell must receive the normal grid background');
  assert(gCell.counts['set:background'] === 1, '(g) normal background must override decorative design classes');
  assert(!gCell.classList.contains('otra-empty-info-cell'), '(g) a filled cell must not retain the decorative marker');

  await result.dispatch('otra:event-rendered');
  assert(gCell.children.length === 2, '(g) reapplying overrides must not duplicate generated title/subtitle');

  gFields['text:.g-info'].value = 'otra-info-cell:{"title":"","subtitle":""}';
  await result.dispatch('otra:event-rendered');
  assert(gCell.children.length === 0, '(g) clearing title and subtitle must remove generated content');
  assert(gCell.classList.contains('otra-empty-info-cell'), '(g) clearing both fields must restore the decorative marker');
  assert(gCell.style.background === '', '(g) clearing both fields must expose the grid accent colour');
  assert(gCell.style.backgroundColor === '', '(g) clearing both fields must remove a stale background colour');
  assert(gCell.style.backgroundImage === '', '(g) clearing both fields must remove a stale background image');
}

// ---- Scenario (h): old single-value info overrides remain compatible ----
{
  const hCell = makeEl('div', { className: 'ev-info-cell' });
  await runScenario({
    fields: {
      'text:.h-info': { type: 'text', value: 'Legacy value-only information' },
    },
    selectors: {
      '.h-info': hCell,
    },
  });
  assert(hCell.children.length === 2, '(h) legacy value must create both editable title/subtitle elements');
  assert(hCell.children[0]?.classList.contains('k'), '(h) legacy value must retain an editable title slot');
  assert(hCell.children[0]?.textContent === '', '(h) legacy value must leave the title empty');
  assert(hCell.children[1]?.classList.contains('v'), '(h) legacy value must retain .v styling');
  assert(hCell.children[1]?.textContent === 'Legacy value-only information', '(h) legacy value text must be preserved');
}

// ---- Scenario (i): legacy child overrides that clear both parts restore colour ----
{
  const iCell = makeEl('div', { className: 'ev-info-cell' });
  const iTitle = makeEl('div', { className: 'k', textContent: 'Tickets' });
  const iSubtitle = makeEl('div', { className: 'v', textContent: 'From ANG 25' });
  iCell.appendChild(iTitle);
  iCell.appendChild(iSubtitle);
  await runScenario({
    fields: {
      'text:.i-info > div:nth-of-type(1)': { type: 'text', value: '' },
      'text:.i-info > div:nth-of-type(2)': { type: 'text', value: '' },
    },
    selectors: {
      '.i-info > div:nth-of-type(1)': iTitle,
      '.i-info > div:nth-of-type(2)': iSubtitle,
    },
  });
  assert(iCell.classList.contains('otra-empty-info-cell'), '(i) two empty legacy child overrides must make the parent decorative');
  assert(iCell.style.background === '', '(i) legacy empty overrides must expose the accent background');
}

if (failures.length) {
  console.error('check-overrides-idempotent FAILED:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('check-overrides-idempotent OK (idempotent applies, no-retry when applied, ceiling respected)');
