// Oracle: a 401 from /admin/api/* while staff are signed in shows a
// "Session expired" banner and keeps the editor, the token and every typed
// value on screen. The banner has its own sign in form that swaps only the
// token (memory and sessionStorage) without logout(), boot() or closing the
// open dialog. Only Sign out (or a failed first load with no page open)
// returns to the login form.
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
assert.match(html, /id="sessionExpiredBanner"[\s\S]{0,800}<form class="session-expired-login" id="sessionExpiredLoginForm">/, 'banner holds an inline sign in form');
for (const id of ['sessionExpiredEmail', 'sessionExpiredPassword', 'sessionExpiredLoginBtn', 'sessionExpiredStatus']) {
  assert.match(html, new RegExp(`id="${id}"`), `${id} present in the banner`);
}
assert.ok(!/sessionExpiredSignInBtn/.test(html), 'no destructive sign in again button left');
assert.match(html, /const SESSION_EXPIRED_MESSAGE = "Session expired\./, 'clear message');
assert.match(html, /addEventListener\("hashchange"[\s\S]{0,120}consumeStudioHandoff\(\)/, 'fresh Studio hash token is picked up without reload');
const apiSrc = extractFunction('api');
assert.ok(!/logout\(|removeItem\(/.test(apiSrc), 'api() never logs out or clears the token');
const bannerHandler = html.match(/\$\("sessionExpiredLoginForm"\)\.addEventListener\("submit", async \(e\) => \{[\s\S]*?\n  \}\);/);
assert.ok(bannerHandler, 'banner sign in handler wired');
assert.ok(!/logout\(|boot\(|closeModal\(|reload\(/.test(bannerHandler[0]), 'banner sign in never logs out, reboots, closes the dialog or reloads');
const staffLoginSrc = extractFunction('staffLogin');
assert.ok(!/logout\(|boot\(|closeModal\(|removeItem\(/.test(staffLoginSrc), 'staffLogin only swaps the token');
const loginFormHandler = html.match(/\$\("loginForm"\)\.addEventListener\("submit", async \(e\) => \{[\s\S]*?\n  \}\);/);
assert.ok(loginFormHandler && /staffLogin\(/.test(loginFormHandler[0]) && /boot\(\)/.test(loginFormHandler[0]), 'login form shares staffLogin then boots');

const msgDecl = html.match(/const SESSION_EXPIRED_MESSAGE = "[^"]*";/)[0];
const source = ['api', 'showSessionExpired', 'hideSessionExpired', 'staffLogin', 'loadPages', 'setStatus'].map(extractFunction).join('\n');

function el(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '', className: '', disabled: false, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
  };
}

function makeCtx({ status, stored = 'jwt.a.b', selectedPage = { id: 'draft-1' }, inEditor = true, loginStatus = 200 }) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); };
  $('sessionExpiredBanner').classList.add('hidden');
  $('loginView').classList.add('hidden');
  if (!inEditor) $('appView').classList.add('hidden');
  $('description').value = 'typed but not saved';
  $('editModal');
  const store = new Map(stored ? [['otra_admin_token', stored]] : []);
  const ctx = {
    $, els, store, calls: [],
    fetch: async (path, options) => {
      ctx.calls.push({ path, body: options && options.body });
      if (path === '/admin/api/login') {
        const ok = loginStatus < 400;
        return { ok, status: loginStatus, json: async () => (ok ? { token: 'jwt.fresh.c' } : { error: 'invalid email or password' }) };
      }
      return { ok: status < 400, status, json: async () => (status === 401 ? { error: 'unauthorized' } : { pages: [] }) };
    },
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
    var logoutCalls = 0, bootCalls = 0, closeModalCalls = 0;
    function logout() { logoutCalls += 1; } async function boot() { bootCalls += 1; } function closeModal() { closeModalCalls += 1; }
    ${source}
    ${bannerHandler[0]}
    this.api = api; this.loadPages = loadPages; this.getToken = () => token;
    this.counts = () => ({ logoutCalls, bootCalls, closeModalCalls });`, ctx);
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
  const ctx = makeCtx({ status: 401, stored: '', loginStatus: 401 });
  await assert.rejects(ctx.api('/admin/api/login', { method: 'POST' }), (err) => {
    assert.equal(err.sessionExpired, false);
    assert.equal(err.message, 'invalid email or password');
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

// 6. Banner sign in succeeds: new token in memory and sessionStorage, banner
//    cleared, dialog and typed text untouched, no logout/boot.
async function submitBanner(ctx) {
  await ctx.$('sessionExpiredLoginForm').listeners.submit({ preventDefault() {} });
}
{
  const ctx = makeCtx({ status: 401 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  assert.equal(bannerShown(ctx), true);
  ctx.$('sessionExpiredEmail').value = 'bot@example.test';
  ctx.$('sessionExpiredPassword').value = 'pw';
  await submitBanner(ctx);
  const login = ctx.calls.find((c) => c.path === '/admin/api/login');
  assert.deepEqual(JSON.parse(login.body), { email: 'bot@example.test', password: 'pw' }, 'posts the same body as the login form');
  assert.equal(ctx.getToken(), 'jwt.fresh.c', 'memory token renewed');
  assert.equal(ctx.store.get('otra_admin_token'), 'jwt.fresh.c', 'sessionStorage token renewed');
  assert.equal(bannerShown(ctx), false, 'banner cleared after sign in');
  assert.equal(ctx.$('sessionExpiredPassword').value, '', 'password not left in the banner');
  assert.equal(ctx.$('description').value, 'typed but not saved', 'typed value kept');
  assert.equal(ctx.$('editModal').classList.contains('hidden'), false, 'edit dialog still open');
  assert.equal(ctx.$('appView').classList.contains('hidden'), false, 'editor still visible');
  assert.equal(ctx.$('loginView').classList.contains('hidden'), true, 'login form not shown');
  assert.match(ctx.$('status').textContent, /Save again/);
  assert.deepEqual({ ...ctx.counts() }, { logoutCalls: 0, bootCalls: 0, closeModalCalls: 0 });
  assert.equal(ctx.$('sessionExpiredLoginBtn').disabled, false);
  checked += 1;
}

// 7. Banner sign in fails (wrong password or Otra Guide down): old token,
//    banner, dialog and typed text all stay; error shown in the banner.
for (const loginStatus of [401, 502]) {
  const ctx = makeCtx({ status: 401, loginStatus });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.$('sessionExpiredEmail').value = 'bot@example.test';
  ctx.$('sessionExpiredPassword').value = 'wrong';
  await submitBanner(ctx);
  assert.equal(bannerShown(ctx), true, 'banner stays');
  assert.match(ctx.$('sessionExpiredStatus').className, /error/);
  assert.equal(ctx.$('sessionExpiredStatus').textContent, 'invalid email or password');
  assert.equal(ctx.getToken(), 'jwt.a.b', 'token unchanged');
  assert.equal(ctx.store.get('otra_admin_token'), 'jwt.a.b');
  assert.equal(ctx.$('description').value, 'typed but not saved', 'typed value kept');
  assert.equal(ctx.$('editModal').classList.contains('hidden'), false, 'edit dialog still open');
  assert.deepEqual({ ...ctx.counts() }, { logoutCalls: 0, bootCalls: 0, closeModalCalls: 0 });
  assert.equal(ctx.$('sessionExpiredLoginBtn').disabled, false);
  checked += 1;
}

// 8. Save after banner sign in uses the fresh token.
{
  const ctx = makeCtx({ status: 401 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.$('sessionExpiredEmail').value = 'bot@example.test';
  ctx.$('sessionExpiredPassword').value = 'pw';
  await submitBanner(ctx);
  const header = vm.runInContext('authHeaders().authorization', ctx);
  assert.equal(header, 'Bearer jwt.fresh.c', 'retry save sends the new token');
  checked += 1;
}

console.log(`check-admin-session-expired: ${checked} groups passed`);
