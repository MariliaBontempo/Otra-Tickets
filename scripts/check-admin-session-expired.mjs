// Oracle: a 401 from /admin/api/* while staff are signed in shows a
// "Session expired" banner and keeps the editor, the token and every typed
// value on screen. The banner has its own sign in form that swaps only the
// token (memory and sessionStorage) without logout(), boot() or closing the
// open dialog. Studio can also push a fresh token by postMessage. A save
// refused by the expiry is retried once on the new token, and the dialog
// text is kept per page in sessionStorage (never the password) so a Cancel
// while expired or a reload can get it back. Only Sign out (or a failed
// first load with no page open) returns to the login form.
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
assert.match(bannerHandler[0], /afterTokenRenewed\(\)/, 'banner sign in retries the blocked save');
const hashHandler = html.match(/window\.addEventListener\("hashchange", \(\) => \{[\s\S]*?\n  \}\);/);
assert.ok(hashHandler && /afterTokenRenewed\(\)/.test(hashHandler[0]), 'hash token refresh shares afterTokenRenewed');
const messageHandler = html.match(/window\.addEventListener\("message", \(event\) => \{[\s\S]*?\n  \}\);/);
assert.ok(messageHandler && /storeStaffToken\(jwt\)/.test(messageHandler[0]) && /afterTokenRenewed\(\)/.test(messageHandler[0]), 'postMessage token applied');
assert.ok(!/logout\(|boot\(|closeModal\(|reload\(/.test(messageHandler[0] + extractFunction('afterTokenRenewed')), 'token refresh never wipes the editor');
const submitHandler = html.match(/\$\("editForm"\)\.addEventListener\("submit", async \(e\) => \{[\s\S]*?\n  \}\);/)[0];
assert.equal((submitHandler.match(/if \(err\.sessionExpired\) noteBlockedSave\(\);/g) || []).length, 2, 'rename and field saves remember a save refused by expiry');
assert.equal((submitHandler.match(/clearUnsavedEdit\(selected\);\s*closeModal\(\);/g) || []).length, 2, 'a successful save clears the kept text');
assert.match(extractFunction('uploadCurrentImage'), /clearUnsavedEdit\(selected\);\s*closeModal\(true\);/, 'a saved upload clears the kept text');
assert.match(extractFunction('openEditor'), /\$\("editModal"\)\.classList\.remove\("hidden"\);\s*restoreUnsavedEdit\(\);/, 'reopening the same field restores kept text');
assert.match(extractFunction('selectPage'), /readUnsavedEdit\(selected\)/, 'opening a page says it has kept text');
for (const id of ['closeModalBtn', 'cancelBtn']) assert.match(html, new RegExp(`\\$\\("${id}"\\)\\.addEventListener\\("click", dismissEditModal\\);`), `${id} keeps text while expired`);
assert.match(html, /\$\("editForm"\)\.addEventListener\("input", scheduleUnsavedEditStash\);/, 'typing is kept (debounced)');
assert.ok(!/password/i.test(extractFunction('unsavedEditInputs')), 'passwords are never kept');

const msgDecl = html.match(/const SESSION_EXPIRED_MESSAGE = "[^"]*";/)[0];
const source = ['api', 'showSessionExpired', 'sessionExpiredShown', 'hideSessionExpired', 'staffLogin', 'storeStaffToken',
  'afterTokenRenewed', 'requestStudioToken', 'isStudioTokenOrigin', 'readStudioTokenMessage', 'isJwtShape', 'unsavedEditKey', 'unsavedEditInputs',
  'editTarget', 'sameEditTarget', 'stashUnsavedEdit', 'scheduleUnsavedEditStash', 'readUnsavedEdit', 'clearUnsavedEdit',
  'restoreUnsavedEdit', 'noteBlockedSave', 'retryBlockedSave', 'dismissEditModal', 'loadPages', 'setStatus'].map(extractFunction).join('\n');
const tokenMsgDecl = [/const STUDIO_TOKEN_MESSAGE = \{[^}]*\};/, /const STUDIO_TOKEN_ORIGINS = \[[^\]]*\];/, /const STUDIO_TOKEN_LOCAL_HOSTS = \[[^\]]*\];/]
  .map((re) => { const m = html.match(re); assert.ok(m, `${re} declared`); return m[0]; }).join(' ');
assert.match(extractFunction('readStudioTokenMessage'), /event\.source === window\.parent && isStudioTokenOrigin\(event\.origin\)/, 'parent messages must pass the origin allowlist');
const prefixDecl = html.match(/const UNSAVED_EDIT_PREFIX = "[^"]*";/)[0];

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

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256' })}.${b64({ user_id: 9 })}.c2ln`;

function makeCtx({ status, stored = 'jwt.a.b', selectedPage = { id: 'draft-1' }, inEditor = true, loginStatus = 200, framed = true }) {
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
    timers: [], submits: 0, toParent: [],
    setTimeout: (fn) => { ctx.timers.push(fn); return ctx.timers.length; }, clearTimeout: () => {},
    location: { origin: 'http://127.0.0.1:8790' }, URL,
  };
  const win = { postMessage() {}, __listeners: {}, addEventListener(type, fn) { this.__listeners[type] = fn; } };
  win.parent = framed ? { postMessage: (msg, origin) => ctx.toParent.push({ msg, origin }) } : win;
  ctx.window = win;
  $('editForm').requestSubmit = () => { ctx.submits += 1; };
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
    function logout() { logoutCalls += 1; } async function boot() { bootCalls += 1; } function closeModal() { closeModalCalls += 1; $("editModal").classList.add("hidden"); }
    function overrideIdForPage(page) { return page ? String(page.id) : ""; } function showImage() {}
    var modalMode = "text", activeField = { key: "text:#evBody" }, mediaUploadBusy = false;
    ${tokenMsgDecl} ${prefixDecl} let unsavedEditTimer = null; let blockedSave = null;
    ${source}
    ${bannerHandler[0]}
    ${messageHandler[0]}
    this.api = api; this.loadPages = loadPages; this.getToken = () => token;
    this.noteBlockedSave = noteBlockedSave; this.dismissEditModal = dismissEditModal; this.restoreUnsavedEdit = restoreUnsavedEdit;
    this.scheduleUnsavedEditStash = scheduleUnsavedEditStash; this.clearSelectedUnsaved = () => clearUnsavedEdit(selected);
    this.setField = (mode, key) => { modalMode = mode; activeField = key ? { key } : null; };
    this.getBlocked = () => blockedSave; this.isStudioTokenOrigin = isStudioTokenOrigin;
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

// 9. A save refused by expiry is retried once, automatically, after the
//    banner sign in; a later token does not resubmit again.
{
  const ctx = makeCtx({ status: 401 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave();
  assert.ok(ctx.store.get('otra_admin_unsaved:draft-1'), 'blocked save text kept at once');
  ctx.$('sessionExpiredEmail').value = 'bot@example.test';
  ctx.$('sessionExpiredPassword').value = 'pw';
  await submitBanner(ctx);
  assert.equal(ctx.submits, 1, 'blocked save retried once');
  assert.match(ctx.$('status').textContent, /Saving your edits/);
  assert.equal(ctx.getBlocked(), null);
  assert.equal(ctx.$('description').value, 'typed but not saved');
  await submitBanner(ctx);
  assert.equal(ctx.submits, 1, 'no second automatic retry');
  assert.deepEqual({ ...ctx.counts() }, { logoutCalls: 0, bootCalls: 0, closeModalCalls: 0 });
  checked += 1;
}

// 10. No retry when the dialog was closed or another field is open.
{
  const ctx = makeCtx({ status: 401 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave();
  ctx.setField('image', 'image:#hero');
  ctx.$('sessionExpiredEmail').value = 'bot@example.test';
  ctx.$('sessionExpiredPassword').value = 'pw';
  await submitBanner(ctx);
  assert.equal(ctx.submits, 0, 'different field is not resubmitted');
  assert.match(ctx.$('status').textContent, /Save again/);
  checked += 1;
}

// 11. Studio postMessage token: applied without wiping, retries the save,
//     acknowledged; other senders and shapes ignored.
{
  const ctx = makeCtx({ status: 401 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.toParent.map((m) => m.msg))), [{ source: 'otra-tickets', type: 'otra_admin_token_request' }], 'expiry asks the Studio parent for a token');
  ctx.noteBlockedSave();
  const fire = (event) => ctx.window.__listeners.message(event);
  const parent = ctx.window.parent;
  const good = { source: 'otra-studio', type: 'otra_admin_token', token: JWT };
  const acks = [];
  const reply = { postMessage: (msg, origin) => acks.push({ msg, origin }) };
  // Ignored: wrong sender, wrong shape, not a JWT.
  fire({ source: { postMessage() {} }, origin: 'https://evil.test', data: good });
  fire({ source: parent, origin: 'https://calendar.test', data: good });
  fire({ source: parent, origin: 'https://otraguide.com.evil.test', data: good });
  fire({ source: parent, origin: 'null', data: good });
  fire({ source: parent, origin: 'https://calendar.test', data: { type: 'otra_admin_token', token: JWT } });
  fire({ source: parent, origin: 'https://calendar.test', data: { ...good, token: 'not a jwt' } });
  fire({ source: parent, origin: 'https://calendar.test', data: 'otra_admin_token ' + JWT });
  assert.equal(ctx.getToken(), 'jwt.a.b', 'ignored messages leave the token');
  assert.equal(bannerShown(ctx), true);
  // Accepted from the framing parent.
  parent.postMessage = reply.postMessage;
  fire({ source: parent, origin: 'https://otraguide.com', data: good });
  assert.equal(ctx.getToken(), JWT, 'memory token from postMessage');
  assert.equal(ctx.store.get('otra_admin_token'), JWT, 'sessionStorage token from postMessage');
  assert.equal(bannerShown(ctx), false, 'banner cleared');
  assert.equal(ctx.$('description').value, 'typed but not saved', 'typed value kept');
  assert.equal(ctx.$('editModal').classList.contains('hidden'), false, 'dialog still open');
  assert.equal(ctx.submits, 1, 'blocked save retried with the new token');
  assert.deepEqual({ ...ctx.counts() }, { logoutCalls: 0, bootCalls: 0, closeModalCalls: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(acks)), [{ msg: { source: 'otra-tickets', type: 'otra_admin_token_applied' }, origin: 'https://otraguide.com' }], 'ack sent only once, to the allowed sender origin');
  checked += 1;
}

// 11b. Origin allowlist: exact Otra Guide origins, local Studio on any
//      port over http, this admin origin; everything else rejected, and a
//      rejected parent message neither applies the token nor gets an ack.
{
  const ctx = makeCtx({ status: 401 });
  for (const origin of ['https://otraguide.com', 'https://www.otraguide.com', 'http://localhost:3000', 'http://localhost:8131', 'http://127.0.0.1:8131', 'http://127.0.0.1:8000', 'http://localhost:8000', 'http://localhost', 'http://127.0.0.1:8790']) {
    assert.equal(ctx.isStudioTokenOrigin(origin), true, `${origin} allowed`);
  }
  for (const origin of ['http://otraguide.com', 'https://otraguide.com:8443', 'https://staging.otraguide.com', 'https://dev.otraguide.com', 'https://otra-dev.otraguide.com',
    'https://do-staging.otraguide.com', 'https://staging-do.otraguide.com', 'https://otraguide.com.evil.test',
    'https://evil.test', 'https://localhost:3000', 'http://localhost.evil.test', 'http://127.0.0.2:8000', 'http://localhost:3000/path', 'null', '', undefined]) {
    assert.equal(ctx.isStudioTokenOrigin(origin), false, `${origin} rejected`);
  }
  const acks = [];
  const parent = ctx.window.parent;
  parent.postMessage = (msg, origin) => acks.push({ msg, origin });
  const good = { source: 'otra-studio', type: 'otra_admin_token', token: JWT };
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  acks.length = 0;
  ctx.window.__listeners.message({ source: parent, origin: 'https://evil.test', data: good });
  assert.equal(ctx.getToken(), 'jwt.a.b', 'foreign origin token not applied');
  assert.equal(bannerShown(ctx), true, 'banner stays for a foreign origin');
  assert.equal(acks.length, 0, 'no applied reply to a foreign origin');
  ctx.window.__listeners.message({ source: parent, origin: 'https://do-staging.otraguide.com', data: good });
  assert.equal(ctx.getToken(), 'jwt.a.b', 'staging origin token not applied');
  assert.equal(acks.length, 0, 'no applied reply to staging');
  ctx.window.__listeners.message({ source: parent, origin: 'http://localhost:5173', data: good });
  assert.equal(ctx.getToken(), JWT, 'local Studio token applied');
  assert.equal(acks.length, 1);
  checked += 1;
}

// 12. Not framed: only this window itself (same origin) may post a token.
{
  const ctx = makeCtx({ status: 401, framed: false });
  const fire = (event) => ctx.window.__listeners.message(event);
  fire({ source: { postMessage() {} }, origin: 'https://evil.test', data: { source: 'otra-studio', type: 'otra_admin_token', token: JWT } });
  assert.equal(ctx.getToken(), 'jwt.a.b');
  fire({ source: ctx.window, origin: 'http://127.0.0.1:8790', data: { source: 'otra-studio', type: 'otra_admin_token', token: JWT } });
  assert.equal(ctx.getToken(), JWT);
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  assert.equal(ctx.toParent.length, 0, 'no token request when not framed');
  checked += 1;
}

// 13. Typed text kept per page (debounced), never the password; Cancel while
//     expired keeps it, reopening the same field restores it, a successful
//     save or a Cancel while signed in clears it.
{
  const ctx = makeCtx({ status: 401 });
  ctx.$('sessionExpiredPassword').value = 'secret-pw';
  ctx.$('description').value = 'my long new text';
  ctx.scheduleUnsavedEditStash();
  assert.equal(ctx.store.get('otra_admin_unsaved:draft-1'), undefined, 'debounced, nothing yet');
  ctx.timers.at(-1)();
  const kept = JSON.parse(ctx.store.get('otra_admin_unsaved:draft-1'));
  assert.equal(kept.values.description, 'my long new text');
  assert.equal(kept.mode, 'text');
  assert.equal(kept.fieldKey, 'text:#evBody');
  assert.ok(!ctx.store.get('otra_admin_unsaved:draft-1').includes('secret-pw'), 'password never kept');
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.dismissEditModal();
  assert.equal(ctx.$('editModal').classList.contains('hidden'), true, 'Cancel closed the dialog');
  assert.ok(ctx.store.get('otra_admin_unsaved:draft-1'), 'Cancel while expired keeps the text');
  // Reopen same field after sign in or reload: openEditor fills the saved
  // value, then restoreUnsavedEdit puts the typed text back.
  ctx.$('editModal').classList.remove('hidden');
  ctx.$('description').value = 'server text';
  assert.equal(ctx.restoreUnsavedEdit(), true);
  assert.equal(ctx.$('description').value, 'my long new text', 'typed text restored');
  assert.match(ctx.$('status').textContent, /Restored/);
  // Another field on the page is not overwritten.
  ctx.setField('text', 'text:#evTitle');
  ctx.$('description').value = 'title text';
  assert.equal(ctx.restoreUnsavedEdit(), false);
  assert.equal(ctx.$('description').value, 'title text');
  // Successful save clears it.
  ctx.clearSelectedUnsaved();
  assert.equal(ctx.store.get('otra_admin_unsaved:draft-1'), undefined, 'cleared after save');
  checked += 1;
}
{
  const ctx = makeCtx({ status: 200 });
  ctx.$('description').value = 'draft text';
  ctx.scheduleUnsavedEditStash();
  ctx.timers.at(-1)();
  assert.ok(ctx.store.get('otra_admin_unsaved:draft-1'));
  ctx.dismissEditModal();
  assert.equal(ctx.store.get('otra_admin_unsaved:draft-1'), undefined, 'Cancel while signed in discards');
  checked += 1;
}

console.log(`check-admin-session-expired: ${checked} groups passed`);
