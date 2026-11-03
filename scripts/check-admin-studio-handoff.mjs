// Oracle: the Studio iframe opens /admin/?edit=<id>#access_token=<jwt> (hash
// only; query tokens are stripped and never used) and
// lands in the editor without the login form. Runs the real handoff helpers
// from admin/index.html in a VM with a stubbed location/history/sessionStorage.
// Run: node scripts/check-admin-studio-handoff.mjs
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

const names = ['isJwtShape', 'readStudioHandoffToken', 'stripStudioHandoffFromUrl', 'storeStaffToken', 'consumeStudioHandoff', 'readEditParam'];
const source = names.map(extractFunction).join('\n');
const keysDecl = html.match(/const STUDIO_HANDOFF_KEYS = \[[^\]]*\];/);
assert.ok(keysDecl, 'STUDIO_HANDOFF_KEYS declared');

// Wiring: keys declared before the early call (no TDZ), handoff after the
// edit read and before the final boot.
const iKeys = html.indexOf(keysDecl[0]);
const iEdit = html.indexOf('let pendingEditId = readEditParam(location.search);');
const iCall = html.indexOf('  consumeStudioHandoff();');
const iBoot = html.lastIndexOf('if (token) boot();');
assert.ok(iKeys >= 0 && iEdit >= 0 && iCall >= 0 && iBoot >= 0, 'wiring present');
assert.ok(iKeys < iCall, 'keys declared before consumeStudioHandoff() runs');
assert.ok(iEdit < iCall, 'edit param read before the URL is rewritten');
assert.ok(iCall < iBoot, 'handoff runs before the final boot');
assert.match(html, /const tokenKey = "otra_admin_token";/);

const header = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
const JWT = `${header({ alg: 'HS256', typ: 'JWT' })}.${header({ user_id: 1, exp: 9999999999 })}.c2lnbmF0dXJlX3Rlc3Q`;
const JWT2 = `${header({ alg: 'HS256' })}.${header({ user_id: 2 })}.b3RoZXI`;

function makeCtx(href, stored = '') {
  const url = new URL(href);
  const store = new Map(stored ? [['otra_admin_token', stored]] : []);
  const ctx = {
    URL, URLSearchParams, String,
    location: { get search() { return url.search; }, get hash() { return url.hash; }, get href() { return url.href; } },
    history: { replaceState: (_s, _t, next) => { const n = new URL(next, url); url.pathname = n.pathname; url.search = n.search; url.hash = n.hash; ctx.replaced += 1; } },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    replaced: 0, url, store,
  };
  vm.createContext(ctx);
  vm.runInContext(`const tokenKey = "otra_admin_token"; ${keysDecl[0]}
    var token = sessionStorage.getItem(tokenKey) || "";
    var pendingEditId = readEditParam(location.search);
    ${source}
    this.result = consumeStudioHandoff();
    this.getToken = () => token; this.getPending = () => pendingEditId;
    this.isJwtShape = isJwtShape; this.readStudioHandoffToken = readStudioHandoffToken;`, ctx);
  return ctx;
}

const tokenIn = (ctx) => ctx.url.href.includes(JWT) || ctx.url.href.includes('access_token') || ctx.url.href.includes('studio_token');

// Hash access_token with ?edit= (canonical Studio shape) on 127.0.0.1.
{
  const ctx = makeCtx(`http://127.0.0.1:8790/admin/?edit=draft-1790000000000-abcd1234#access_token=${JWT}`);
  assert.equal(ctx.result, true);
  assert.equal(ctx.getToken(), JWT, 'token set');
  assert.equal(ctx.store.get('otra_admin_token'), JWT, 'stored under otra_admin_token');
  assert.equal(tokenIn(ctx), false, 'token removed from the address bar');
  assert.equal(ctx.url.search, '?edit=draft-1790000000000-abcd1234', 'edit kept');
  assert.equal(ctx.url.hash, '');
  assert.equal(ctx.getPending(), 'draft-1790000000000-abcd1234', 'deep link still pending for boot');
}

// Hash studio_token on localhost; other hash params kept.
{
  const ctx = makeCtx(`http://localhost:8790/admin/?edit=7514#studio_token=${JWT}&foo=bar`);
  assert.equal(ctx.getToken(), JWT);
  assert.equal(tokenIn(ctx), false);
  assert.equal(ctx.url.search, '?edit=7514');
  assert.equal(ctx.url.hash, '#foo=bar', 'unrelated hash params kept');
}

// Bare JWT as the whole hash.
{
  const ctx = makeCtx(`http://127.0.0.1:8790/admin/?edit=7514#${JWT}`);
  assert.equal(ctx.getToken(), JWT);
  assert.equal(ctx.url.hash, '');
  assert.equal(ctx.url.search, '?edit=7514');
}

// Query access_token / studio_token never sign in (query reaches server
// logs). They are still stripped, edit kept regardless of order, and an
// existing session is left as it was.
for (const q of [`?access_token=${JWT}&edit=7514`, `?edit=7514&studio_token=${JWT}`]) {
  for (const stored of ['', JWT2]) {
    const ctx = makeCtx(`http://host.docker.internal:8790/admin/${q}`, stored);
    assert.equal(ctx.result, false, `${q} not accepted`);
    assert.equal(ctx.getToken(), stored, `${q} does not set the session token`);
    assert.equal(ctx.store.get('otra_admin_token'), stored || undefined, `${q} not stored`);
    assert.equal(tokenIn(ctx), false, `${q} stripped`);
    assert.equal(ctx.url.search, '?edit=7514', `${q} keeps edit`);
    assert.equal(ctx.getPending(), '7514', `${q} deep link still pending`);
  }
}

// Hash is used when both are present; the query token is ignored; both stripped.
{
  const ctx = makeCtx(`http://127.0.0.1:8790/admin/?access_token=${JWT2}#access_token=${JWT}`);
  assert.equal(ctx.getToken(), JWT);
  assert.equal(ctx.url.search, '');
  assert.equal(ctx.url.hash, '');
}

// Helper reads the hash only.
{
  const ctx = makeCtx('http://127.0.0.1:8790/admin/');
  assert.equal(ctx.readStudioHandoffToken(`#access_token=${JWT}`), JWT);
  assert.equal(ctx.readStudioHandoffToken(`#edit=7514`), '');
  assert.equal(ctx.readStudioHandoffToken(''), '');
  assert.equal(ctx.readStudioHandoffToken.length, 1, 'takes the hash only');
  assert.doesNotMatch(extractFunction('readStudioHandoffToken'), /search|URLSearchParams\(search/);
  assert.match(extractFunction('consumeStudioHandoff'), /readStudioHandoffToken\(location\.hash\)/);
}

// New handoff replaces an older stored session.
{
  const ctx = makeCtx(`http://127.0.0.1:8790/admin/#access_token=${JWT}`, JWT2);
  assert.equal(ctx.getToken(), JWT);
  assert.equal(ctx.store.get('otra_admin_token'), JWT);
}

// Garbage is rejected, still stripped, and never overwrites the stored session.
for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', 'a..c', 'a.b.c%3Cscript%3E', '%20']) {
  for (const where of ['hash', 'query']) {
    const href = where === 'hash'
      ? `http://127.0.0.1:8790/admin/?edit=7514#access_token=${bad}`
      : `http://127.0.0.1:8790/admin/?edit=7514&access_token=${bad}`;
    const ctx = makeCtx(href, JWT2);
    assert.equal(ctx.result, false, `${where} ${JSON.stringify(bad)} rejected`);
    assert.equal(ctx.getToken(), JWT2, 'existing session not overwritten');
    assert.equal(ctx.store.get('otra_admin_token'), JWT2);
    assert.equal(ctx.url.href.includes('access_token'), false, 'bad token still stripped');
    assert.equal(ctx.url.search, '?edit=7514');
  }
}

// Empty handoff with no stored session leaves token empty (login shows).
{
  const ctx = makeCtx('http://127.0.0.1:8790/admin/?edit=7514#access_token=');
  assert.equal(ctx.getToken(), '');
  assert.equal(ctx.store.has('otra_admin_token'), false);
}

// No handoff: URL untouched, no replaceState.
{
  const ctx = makeCtx('http://127.0.0.1:8790/admin/?edit=7514#section');
  assert.equal(ctx.result, false);
  assert.equal(ctx.replaced, 0);
  assert.equal(ctx.url.hash, '#section');
}

{
  const ctx = makeCtx('http://127.0.0.1:8790/admin/');
  assert.equal(ctx.isJwtShape(JWT), true);
  assert.equal(ctx.isJwtShape(` ${JWT} `), true);
  assert.equal(ctx.isJwtShape(null), false);
  assert.equal(ctx.isJwtShape('a.b.c'), true, 'shape only; server checks staff');
}

console.log('check-admin-studio-handoff: ok');
