import assert from "node:assert/strict";
import test from "node:test";
import { TOKEN, mockGuide } from "./helpers/mock-guide.mjs";
import { onRequestPost as login } from "../../functions/api/login.js";
import { onRequestGet as me } from "../../functions/api/me.js";
import { onRequestPost as logout } from "../../functions/api/logout.js";
import { clearSessionCookie, readSessionToken, requestToken, sessionCookie } from "../../functions/_lib/session.js";

const env = { OTRA_API_URL: "https://guide.test/api" };

const post = (body) => new Request("https://t.test/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("cookie helpers", () => {
  assert.equal(sessionCookie("abc"), "otra_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=5184000");
  assert.match(clearSessionCookie(), /^otra_session=; .*Max-Age=0/);
  const req = new Request("https://t.test/", { headers: { cookie: "a=1; otra_session=xyz; b=2" } });
  assert.equal(readSessionToken(req), "xyz");
  assert.equal(readSessionToken(new Request("https://t.test/")), null);
  const both = new Request("https://t.test/", { headers: { cookie: "otra_session=c", authorization: "Bearer h" } });
  assert.equal(requestToken(both), "h");
  assert.equal(requestToken(new Request("https://t.test/", { headers: { cookie: "otra_session=c" } })), "c");
});

test("login success sets the cookie and never returns the token", async () => {
  const restore = mockGuide({ isStaff: true });
  try {
    const res = await login({ request: post({ email: "ana@x.com", password: "pw" }), env });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("set-cookie"), sessionCookie(TOKEN));
    const text = await res.text();
    assert.ok(!text.includes(TOKEN));
    assert.deepEqual(JSON.parse(text), { user: { name: "Ana Silva", email: "ana@x.com", isStaff: true } });
  } finally { restore(); }
});

test("login rejects bad password, missing fields, and unreachable Guide", async () => {
  let restore = mockGuide({ tokenOk: false });
  try {
    const res = await login({ request: post({ email: "a@x.com", password: "bad" }), env });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.deepEqual(await res.json(), { error: "Wrong email or password." });
  } finally { restore(); }
  restore = mockGuide();
  try {
    assert.equal((await login({ request: post({ email: "a@x.com" }), env })).status, 400);
  } finally { restore(); }
  restore = mockGuide({ down: true });
  try {
    assert.equal((await login({ request: post({ email: "a@x.com", password: "p" }), env })).status, 502);
  } finally { restore(); }
});

test("me reports a valid session", async () => {
  const restore = mockGuide({ isStaff: true });
  try {
    const request = new Request("https://t.test/api/me", { headers: { cookie: `otra_session=${TOKEN}` } });
    const res = await me({ request, env });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { signedIn: true, user: { name: "Ana Silva", email: "ana@x.com", isStaff: true } });
  } finally { restore(); }
});

test("me clears a rejected token and handles no cookie", async () => {
  const restore = mockGuide({ roleStatus: 401 });
  try {
    const request = new Request("https://t.test/api/me", { headers: { cookie: `otra_session=${TOKEN}` } });
    const res = await me({ request, env });
    assert.deepEqual(await res.json(), { signedIn: false });
    assert.equal(res.headers.get("set-cookie"), clearSessionCookie());
    const anon = await me({ request: new Request("https://t.test/api/me"), env });
    assert.deepEqual(await anon.json(), { signedIn: false });
    assert.equal(anon.headers.get("cache-control"), "no-store");
  } finally { restore(); }
});

test("logout clears the cookie", async () => {
  const res = await logout({ request: new Request("https://t.test/api/logout", { method: "POST" }), env });
  assert.equal(res.headers.get("set-cookie"), clearSessionCookie());
  assert.deepEqual(await res.json(), { signedIn: false });
});
