// Oracle: a 401 from /admin/api/* while staff are signed in shows a
// "Session expired" banner and keeps the editor, the token and every typed
// value on screen. Only an explicit sign in again (or a failed first load
// with no page open) returns to the login form.
// Runs the real api(), loadPages() and banner helpers from admin/index.html
// in a VM with stubbed DOM, fetch and sessionStorage.
// Run: node scripts/check-admin-session-expired.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `${name} must exist in admin/index.html`);
  const open = html.indexOf('{', html.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') { depth -= 1; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`${name} not closed`);
}

// Markup and wiring.
assert.match(html, /id="sessionExpiredBanner"[^>]*role="alert"/, 'banner markup present');
assert.match(html, /id="sessionExpiredSignInBtn"/, 'sign in again button present');
assert.match(html, /const SESSION_EXPIRED_MESSAGE = "Session expired\./, 'clear message');
assert.match(html, /addEventListener\("hashchange"[\s\S]{0,120}consumeStudioHandoff\(\)/, 'fresh Studio hash token is picked up without reload');
const apiSrc = extractFunction('api');
assert.ok(!/logout\(|removeItem\(/.test(apiSrc), 'api() never logs out or clears the token');
const signInHandler = html.match(/\$\("sessionExpiredSignInBtn"\)\.addEventListener\("click", \(\) => \{[\s\S]*?\n  \}\);/);
assert.ok(signInHandler && /confirm\(/.test(signInHandler[0]) && /logout\(\)/.test(signInHandler[0]), 'sign in again asks before logging out');

const msgDecl = html.match(/const SESSION_EXPIRED_MESSAGE = "[^"]*";/)[0];
const source = ['api', 'showSessionExpired', 'hideSessionExpired', 'loadPages', 'setStatus'].map(extractFunction).join('\n');

function el(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '', className: '',
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
  };
}

function makeCtx({ status, stored = 'jwt.a.b', selectedPage = { id: 'draft-1' }, inEditor = true }) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); };
  $('sessionExpiredBanner').classList.add('hidden');
  $('loginView').classList.add('hidden');
  if (!inEditor) $('appView').classList.add('hidden');
  $('description').value = 'typed but not saved';
  const store = new Map(stored ? [['otra_admin_token', stored]] : []);
  const ctx = {
    $, els, store, calls: [],
    fetch: async (path) => { ctx.calls.push(path); return { ok: status < 400, status, json: async () => (status === 401 ? { error: 'unauthorized' } : { pages: [] }) }; },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  };
  vm.createContext(ctx);
  vm.runInContext(`const tokenKey = "otra_admin_token"; ${msgDecl}
    var token = sessionStorage.getItem(tokenKey) || "";
    var selected = ${JSON.stringify(selectedPage)};
    var pages = [];
    const loginView = $("loginView"), appView = $("appView"), hubView = $("hubView"), addView = $("addView"), homepageView = $("homepageView"), statusEl = $("status");
    function authHeaders() { return { authorization: "Bearer " + token }; }
    function resolveEditPageId() { return ""; } function clearEditParam() {}
    function renderPageSelectOptions() {} async function selectPage() {}
    ${source}
    this.api = api; this.loadPages = loadPages; this.getToken = () => token;`, ctx);
  return ctx;
}

const bannerShown = (ctx) => !ctx.$('sessionExpiredBanner').classList.contains('hidden');
let checked = 0;

// 1. Save 401 while editing: banner, clear error, token and fields kept.
{
  const ctx = makeCtx({ status: 401 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }), (err) => {
    assert.equal(err.sessionExpired, true);
    assert.equal(err.status, 401);
    assert.match(err.message, /Session expired/);
    return true;
  });
  assert.equal(bannerShown(ctx), true, 'banner visible');
  assert.equal(ctx.getToken(), 'jwt.a.b', 'token kept');
  assert.equal(ctx.store.get('otra_admin_token'), 'jwt.a.b', 'stored token kept');
  assert.equal(ctx.$('description').value, 'typed but not saved', 'typed value kept');
  checked += 1;
}

// 2. Reload of pages hits 401 with the editor open: no login wall.
{
  const ctx = makeCtx({ status: 401 });
  await ctx.loadPages('draft-1');
  assert.equal(bannerShown(ctx), true);
  assert.equal(ctx.$('appView').classList.contains('hidden'), false, 'editor stays visible');
  assert.equal(ctx.$('loginView').classList.contains('hidden'), true, 'login form not shown');
  assert.equal(ctx.getToken(), 'jwt.a.b');
  assert.match(ctx.$('status').textContent, /Session expired/);
  assert.equal(ctx.$('description').value, 'typed but not saved');
  checked += 1;
}

// 3. First load with a stale token and no page open: today's login form.
{
  const ctx = makeCtx({ status: 401, selectedPage: null, inEditor: false });
  await ctx.loadPages();
  assert.equal(ctx.$('loginView').classList.contains('hidden'), false, 'login form shown');
  assert.equal(ctx.getToken(), '', 'stale token cleared');
  assert.equal(bannerShown(ctx), false, 'banner hidden on the login form');
  checked += 1;
}

// 4. Login 401 (wrong password) is not a session expiry.
{
  const ctx = makeCtx({ status: 401, stored: '' });
  await assert.rejects(ctx.api('/admin/api/login', { method: 'POST' }), (err) => {
    assert.equal(err.sessionExpired, false);
    assert.equal(err.message, 'unauthorized');
    return true;
  });
  assert.equal(bannerShown(ctx), false);
  checked += 1;
}

// 5. Other errors keep their server message and no banner.
{
  const ctx = makeCtx({ status: 500 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', {}), (err) => err.sessionExpired === false);
  assert.equal(bannerShown(ctx), false);
  checked += 1;
}

console.log(`check-admin-session-expired: ${checked} groups passed`);
