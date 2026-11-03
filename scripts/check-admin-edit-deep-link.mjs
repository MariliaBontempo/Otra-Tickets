// Oracle: /admin/?edit=<pageId> opens that page in the editor after staff login.
// Runs the real admin boot / loadPages code in a VM with a stubbed DOM.
// Run: node scripts/check-admin-edit-deep-link.mjs
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

const names = ['readEditParam', 'resolveEditPageId', 'clearEditParam', 'openEditDeepLink', 'loadPages', 'boot', 'hideSessionExpired'];
const source = names.map(extractFunction).join('\n');

assert.match(html, /let pendingEditId = readEditParam\(location\.search\);/, 'edit param read on load');
assert.match(extractFunction('boot'), /if \(pendingEditId\) await openEditDeepLink\(pendingEditId\);/, 'boot continues to the deep link');
assert.match(html, /await staffLogin\(\$\("email"\)\.value, \$\("password"\)\.value\);\s*hideSessionExpired\(\);\s*await boot\(\);/, 'login submit runs boot so the link continues after login');
assert.match(extractFunction('staffLogin'), /storeStaffToken\(data\.token\);/, 'shared login stores the token');
assert.match(extractFunction('storeStaffToken'), /sessionStorage\.setItem\(tokenKey, jwt\);/, 'token kept in sessionStorage');
assert.match(html, /if \(token\) boot\(\);/, 'existing session boots straight into the link');

function classList() {
  const set = new Set(['hidden']);
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: (c) => set.has(c) };
}
function makeCtx({ search, pages, apiError }) {
  const els = {};
  const el = (id) => (els[id] ||= { id, textContent: '', value: '', classList: classList(), removeAttribute() {} });
  const url = new URL(`https://tickets.test/admin/${search}`);
  const ctx = {
    URL, URLSearchParams, String, Error,
    location: { get search() { return url.search; }, get href() { return url.href; } },
    history: { replaceState: (_s, _t, next) => { const n = new URL(next, url); url.search = n.search; } },
    sessionStorage: { removeItem() {} },
    $: el,
    loginView: { classList: classList() }, appView: { classList: classList() }, addView: { classList: classList() },
    homepageView: { classList: classList() }, hubView: { classList: classList() },
    authHeaders: () => ({}),
    api: async () => { if (apiError) throw new Error(apiError); return { pages }; },
    renderPageSelectOptions() {},
    setStatus(text) { ctx.status = text; },
    selected: null, token: 't', tokenKey: 'otra_admin_token', selectedIds: [],
    async selectPage(id) { ctx.selectedIds.push(id); },
    url,
  };
  vm.createContext(ctx);
  vm.runInContext(`${source}\nvar pendingEditId = readEditParam(location.search); var pages = [];
    this.boot = boot; this.readEditParam = readEditParam; this.resolveEditPageId = resolveEditPageId;
    this.getPending = () => pendingEditId;`, ctx);
  return ctx;
}

const pages = [
  { id: 'draft-1790000000000-abcd1234', title: 'Draft' },
  { id: '7514', title: 'Sunday Social Club', projectId: 'draft-1780000000000-11112222' },
  { id: 'draft-1799999999999-ffff0000', title: 'Newest' },
];

{
  const ctx = makeCtx({ search: '', pages });
  assert.equal(ctx.readEditParam('?edit=draft-1790000000000-abcd1234'), 'draft-1790000000000-abcd1234');
  assert.equal(ctx.readEditParam('?edit=7514'), '7514');
  assert.equal(ctx.readEditParam('?edit=<script>'), '', 'junk ids ignored');
  assert.equal(ctx.readEditParam('?edit='), '');
  assert.equal(ctx.readEditParam(''), '');
  assert.equal(ctx.resolveEditPageId(pages, 'draft-1780000000000-11112222'), '7514', 'published draft id maps to its live page');
  assert.equal(ctx.resolveEditPageId(pages, 'draft-0-nope'), '');
}

// Draft id opens that draft in the editor and the param is consumed.
{
  const ctx = makeCtx({ search: '?edit=draft-1790000000000-abcd1234', pages });
  await ctx.boot();
  assert.deepEqual(ctx.selectedIds, ['draft-1790000000000-abcd1234'], 'editor opens the linked draft, not pages[0]');
  assert.equal(ctx.appView.classList.contains('hidden'), false, 'editor visible');
  assert.equal(ctx.hubView.classList.contains('hidden'), true, 'hub hidden');
  assert.equal(ctx.url.search, '', 'edit param removed after use');
  assert.equal(ctx.getPending(), '');
}

// Numeric Guide id and published draft id.
for (const [search, want] of [['?edit=7514', '7514'], ['?edit=draft-1780000000000-11112222', '7514']]) {
  const ctx = makeCtx({ search, pages });
  await ctx.boot();
  assert.deepEqual(ctx.selectedIds, [want], `${search} opens ${want}`);
}

// Unknown id: hub with a message, never a different page.
{
  const ctx = makeCtx({ search: '?edit=draft-0-deadbeef', pages });
  await ctx.boot();
  assert.deepEqual(ctx.selectedIds, [], 'unknown id opens nothing');
  assert.equal(ctx.hubView.classList.contains('hidden'), false, 'back on hub');
  assert.match(ctx.$('hubStatus').textContent, /Could not find page draft-0-deadbeef/);
  assert.equal(ctx.url.search, '');
}

// Expired session: login shows and the link is kept for after login.
{
  const ctx = makeCtx({ search: '?edit=draft-1790000000000-abcd1234', pages, apiError: 'unauthorized' });
  await ctx.boot();
  assert.equal(ctx.loginView.classList.contains('hidden'), false, 'login shown');
  assert.equal(ctx.getPending(), 'draft-1790000000000-abcd1234', 'link kept across login');
  ctx.api = async () => ({ pages });
  await ctx.boot();
  assert.deepEqual(ctx.selectedIds, ['draft-1790000000000-abcd1234'], 'after login the linked draft opens');
}

// No param: hub as before.
{
  const ctx = makeCtx({ search: '', pages });
  await ctx.boot();
  assert.deepEqual(ctx.selectedIds, []);
  assert.equal(ctx.hubView.classList.contains('hidden'), false);
}

console.log('check-admin-edit-deep-link: ok');
