// Oracle: a 401 from /admin/api/* while staff are signed in shows a
// "Session expired" banner and keeps the editor, the token and every typed
// value on screen. The banner has its own sign in form that swaps only the
// token (memory and sessionStorage) without logout(), boot() or closing the
// open dialog. Studio can also hand over a fresh #access_token hash (the
// postMessage path is deferred, so none is listened for). A save refused by
// the expiry is retried once on the new token, and the dialog
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
assert.ok(!/addEventListener\("message"|otra_admin_token_|STUDIO_TOKEN_/.test(html), 'no postMessage token path in this ship (hash only)');
// The only postMessage is the outgoing Guide title notice to Studio: it never carries a token.
for (const line of html.split('\n').filter((l) => l.includes('postMessage('))) {
  assert.ok(!/token|authorization|bearer/i.test(line), 'postMessage never carries a token: ' + line.trim());
}
const notice = html.slice(html.indexOf('function announceGuideTitleSaved'), html.indexOf('function applyGuideTitle'));
assert.ok(/type: "otra-tickets:guide-title-saved", eventId: [^,]+, title: guideTitle\.title \}/.test(notice), 'title notice carries only type, eventId and title');
assert.ok(!/postMessage\([^)]*"\*"/.test(html), 'never posts to "*"');
assert.ok(!/logout\(|boot\(|closeModal\(|reload\(/.test(hashHandler[0] + extractFunction('afterTokenRenewed')), 'token refresh never wipes the editor');
const submitHandler = html.match(/\$\("editForm"\)\.addEventListener\("submit", async \(e\) => \{[\s\S]*?\n  \}\);/)[0];
assert.equal((submitHandler.match(/if \(err\.sessionExpired\) noteBlockedSave\(submittedValues, submittedTarget\);/g) || []).length, 1, 'rename remembers a save refused by expiry');
assert.equal((submitHandler.match(/if \(err\.sessionExpired && !overrideSaved\) noteBlockedSave\(submittedValues, submittedTarget\);/g) || []).length, 1, 'field save remembers only a refused override save, never a 401 on the later price/date sync');
assert.match(submitHandler, /if \(!selected\) return;\s*\/\/[^\n]*\n\s*syncRichEditor\(\);\s*const submittedValues = dialogValues\(\);\s*const submittedTarget = editTarget\(\);/, 'values and dialog snapshotted when Save is pressed, before any request');
assert.match(html, /removeVideoFields\(next, activeKey\)\);\s*clearBlockedSave\(\);/, 'Remove video success clears a leftover blocked save');
assert.ok(!/Nothing was saved/.test(html.match(/id="sessionExpiredBanner"[\s\S]{0,400}/)[0]), 'banner does not claim nothing was saved (a sync 401 can follow a saved override)');
assert.match(submitHandler, /await persistCurrentOverride\(\);\s*overrideSaved = true;/, 'override marked saved before the price/date sync');
assert.match(submitHandler, /Text saved, but the session expired before the ticket price or date could update/, 'sync 401 after a saved override does not say nothing was saved');
assert.equal((submitHandler.match(/clearBlockedSave\(\);\s*clearUnsavedEdit\(selected\);\s*closeModal\(\);/g) || []).length, 2, 'a successful save clears a leftover blocked save, the banner and the kept text');
assert.match(extractFunction('uploadCurrentImage'), /clearBlockedSave\(\);\s*clearUnsavedEdit\(selected\);\s*closeModal\(true\);/, 'a saved upload clears a leftover blocked save and the kept text');
assert.ok(!/noteBlockedSave|requestSubmit/.test(extractFunction('uploadCurrentImage')), 'uploads are never remembered for an automatic retry');
assert.match(extractFunction('openEditor'), /\$\("editModal"\)\.classList\.remove\("hidden"\);\s*restoreUnsavedEdit\(\);/, 'reopening the same field restores kept text');
assert.match(extractFunction('selectPage'), /readUnsavedEdit\(selected\)/, 'opening a page says it has kept text');
for (const id of ['closeModalBtn', 'cancelBtn']) assert.match(html, new RegExp(`\\$\\("${id}"\\)\\.addEventListener\\("click", dismissEditModal\\);`), `${id} keeps text while expired`);
assert.match(html, /\$\("editForm"\)\.addEventListener\("input", scheduleUnsavedEditStash\);/, 'typing is kept (debounced)');
assert.ok(!/password/i.test(extractFunction('unsavedEditInputs')), 'passwords are never kept');

const msgDecl = html.match(/const SESSION_EXPIRED_MESSAGE = "[^"]*";/)[0];
const source = ['api', 'showSessionExpired', 'sessionExpiredShown', 'hideSessionExpired', 'staffLogin', 'storeStaffToken',
  'afterTokenRenewed', 'unsavedEditKey', 'unsavedEditInputs',
  'editTarget', 'sameEditTarget', 'stashUnsavedEdit', 'scheduleUnsavedEditStash', 'readUnsavedEdit', 'clearUnsavedEdit',
  'restoreUnsavedEdit', 'dialogValues', 'noteBlockedSave', 'imageFileChosen', 'retryBlockedSave', 'clearBlockedSave', 'dismissEditModal', 'loadPages', 'setStatus'].map(extractFunction).join('\n');
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
    timers: [], submits: 0,
    setTimeout: (fn) => { ctx.timers.push(fn); return ctx.timers.length; }, clearTimeout: () => {},
    location: { origin: 'http://127.0.0.1:8790' }, URL,
  };
  ctx.window = { __listeners: {}, addEventListener(type, fn) { this.__listeners[type] = fn; } };
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
    var richTextMode = false; function restoreRichEditors() {}
    ${prefixDecl} let unsavedEditTimer = null; let blockedSave = null;
    ${source}
    ${bannerHandler[0]}
    this.api = api; this.loadPages = loadPages; this.getToken = () => token;
    const realNoteBlockedSave = noteBlockedSave; this.noteBlockedSave = (v, t) => realNoteBlockedSave(v === undefined ? dialogValues() : v, t === undefined ? editTarget() : t); this.editTarget = editTarget; this.dialogValues = dialogValues; this.dismissEditModal = dismissEditModal; this.restoreUnsavedEdit = restoreUnsavedEdit;
    this.scheduleUnsavedEditStash = scheduleUnsavedEditStash; this.clearSelectedUnsaved = () => clearUnsavedEdit(selected);
    this.setField = (mode, key) => { modalMode = mode; activeField = key ? { key } : null; };
    this.getBlocked = () => blockedSave; this.clearBlockedSave = clearBlockedSave; this.retryBlockedSave = retryBlockedSave;
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

// 11. Studio hash token mid edit: same no wipe path, blocked save retried
//     once (the real hashchange handler with a stubbed consumeStudioHandoff).
{
  const ctx = makeCtx({ status: 401 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave();
  vm.runInContext(`function consumeStudioHandoff() { storeStaffToken(${JSON.stringify(JWT)}); return true; }
    ${hashHandler[0]}`, ctx);
  ctx.window.__listeners.hashchange();
  assert.equal(ctx.getToken(), JWT, 'hash token applied');
  assert.equal(ctx.store.get('otra_admin_token'), JWT);
  assert.equal(bannerShown(ctx), false, 'banner cleared');
  assert.equal(ctx.submits, 1, 'blocked save retried once on the hash token');
  assert.equal(ctx.$('description').value, 'typed but not saved');
  assert.deepEqual({ ...ctx.counts() }, { logoutCalls: 0, bootCalls: 0, closeModalCalls: 0 });
  checked += 1;
}

// 12. The automatic retry only resends exactly what was refused: text
//     edited after the 401, a file picked after the 401, or a later
//     successful manual save all stop it.
async function signInFromBanner(ctx) {
  ctx.$('sessionExpiredEmail').value = 'bot@example.test';
  ctx.$('sessionExpiredPassword').value = 'pw';
  await submitBanner(ctx);
}
{
  const ctx = makeCtx({ status: 401 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave();
  assert.equal(ctx.getBlocked().values.description, 'typed but not saved', 'refused values snapshotted');
  ctx.$('description').value = 'edited after the expiry';
  await signInFromBanner(ctx);
  assert.equal(ctx.submits, 0, 'text changed after the refused save is not auto submitted');
  assert.equal(ctx.getBlocked(), null);
  assert.match(ctx.$('status').textContent, /Save again/);
  assert.equal(ctx.$('description').value, 'edited after the expiry', 'edit kept on screen');
  checked += 1;
}
{
  const ctx = makeCtx({ status: 401 });
  ctx.setField('image', 'image:#hero');
  ctx.$('imageUrl').value = 'https://example.test/a.jpg';
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave();
  ctx.$('imageInput').files = [{ name: 'picked.jpg' }];
  await signInFromBanner(ctx);
  assert.equal(ctx.submits, 0, 'a file picked after the refused save is never auto uploaded');
  checked += 1;
}
{
  const ctx = makeCtx({ status: 401 });
  ctx.setField('image', 'image:#hero');
  ctx.$('imageUrl').value = 'https://example.test/a.jpg';
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave();
  ctx.$('imageInput').files = [];
  await signInFromBanner(ctx);
  assert.equal(ctx.submits, 1, 'unchanged image URL with no file is retried once');
  checked += 1;
}
{
  // Stale retry: a 401 (e.g. Guide hiccup) then a manual Save that works.
  const ctx = makeCtx({ status: 401 });
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave();
  assert.equal(bannerShown(ctx), true);
  ctx.clearBlockedSave();
  assert.equal(ctx.getBlocked(), null, 'successful save drops the blocked save');
  assert.equal(bannerShown(ctx), false, 'successful save hides the stale banner');
  assert.equal(ctx.retryBlockedSave(), false);
  assert.equal(ctx.submits, 0, 'nothing resubmitted later');
  checked += 1;
}
{
  // Typed while the refused save was in flight: snapshot is from Save time,
  // so the newer text differs and is not auto submitted.
  const ctx = makeCtx({ status: 401 });
  ctx.$('description').value = '$50';
  const submitted = ctx.dialogValues();
  ctx.$('description').value = '$500';
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave(submitted);
  assert.equal(ctx.getBlocked().values.description, '$50', 'snapshot is what Save sent');
  await signInFromBanner(ctx);
  assert.equal(ctx.submits, 0, 'text typed during the refused request is never auto submitted');
  assert.equal(ctx.$('description').value, '$500', 'newer text kept on screen for a manual Save');
  assert.match(ctx.$('status').textContent, /Save again/);
  checked += 1;
}
{
  // Typed during flight then put back to exactly what was sent: same request, retried once.
  const ctx = makeCtx({ status: 401 });
  ctx.$('description').value = '$50';
  const submitted = ctx.dialogValues();
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave(submitted);
  await signInFromBanner(ctx);
  assert.equal(ctx.submits, 1);
  checked += 1;
}
{
  // Save pressed on one field, dialog switched to another field with the
  // same text during the request: the retry stays bound to the first field
  // and does not submit the second.
  const ctx = makeCtx({ status: 401 });
  ctx.$('description').value = '$50';
  const submitted = ctx.dialogValues();
  const target = ctx.editTarget();
  ctx.setField('text', 'text:#evPrice');
  await assert.rejects(ctx.api('/admin/api/overrides?id=draft-1', { method: 'PUT' }));
  ctx.noteBlockedSave(submitted, target);
  assert.equal(ctx.getBlocked().fieldKey, 'text:#evBody', 'target is the field Save was pressed on');
  await signInFromBanner(ctx);
  assert.equal(ctx.submits, 0, 'another field is never auto submitted');
  checked += 1;
}
{
  // No captured dialog: never retried.
  const ctx = makeCtx({ status: 401 });
  ctx.noteBlockedSave(ctx.dialogValues(), null);
  assert.equal(ctx.getBlocked(), null);
  checked += 1;
}
{
  // Blocked save with no snapshot (defensive) is never retried.
  const ctx = makeCtx({ status: 401 });
  vm.runInContext('blockedSave = editTarget();', ctx);
  assert.equal(ctx.retryBlockedSave(), false);
  assert.equal(ctx.submits, 0);
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
