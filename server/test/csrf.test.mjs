import assert from "node:assert/strict";
import test from "node:test";
import { onRequestPost as login } from "../../functions/api/login.js";
import { onRequestPost as logout } from "../../functions/api/logout.js";
import { clearSessionCookie, sessionCookie } from "../../functions/_lib/session.js";
import { TOKEN, mockGuide } from "./helpers/mock-guide.mjs";

const env = { OTRA_API_URL: "https://guide.test/api" };
const JSON_TYPE = "application/json";
const creds = JSON.stringify({ email: "ana@x.com", password: "pw" });

const loginReq = (headers = {}, { url = "https://otratickets.com/api/login", type = JSON_TYPE } = {}) =>
  new Request(url, { method: "POST", headers: { ...(type ? { "content-type": type } : {}), ...headers }, body: creds });
const logoutReq = (headers = {}, url = "https://otratickets.com/api/logout") =>
  new Request(url, { method: "POST", headers });

test("login rejects a cross-site Origin", async () => {
  const restore = mockGuide();
  try {
    const res = await login({ request: loginReq({ origin: "https://evil.example" }), env });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "forbidden" });
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(restore.calls, 0);
  } finally { restore(); }
});

test("logout rejects a cross-site Origin", async () => {
  const res = await logout({ request: logoutReq({ origin: "https://evil.example" }), env });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("same-origin login and logout are accepted", async () => {
  for (const origin of ["https://otratickets.com", "https://www.otratickets.com"]) {
    const restore = mockGuide();
    try {
      const res = await login({ request: loginReq({ origin }), env });
      assert.equal(res.status, 200, origin);
      assert.equal(res.headers.get("set-cookie"), sessionCookie(TOKEN));
    } finally { restore(); }
    const out = await logout({ request: logoutReq({ origin }), env });
    assert.equal(out.status, 200, origin);
    assert.equal(out.headers.get("set-cookie"), clearSessionCookie());
  }
});

test("missing Origin with Sec-Fetch-Site cross-site or same-site is rejected", async () => {
  for (const site of ["cross-site", "same-site"]) {
    const restore = mockGuide();
    try {
      const res = await login({ request: loginReq({ "sec-fetch-site": site }), env });
      assert.equal(res.status, 403, site);
      assert.equal(restore.calls, 0);
    } finally { restore(); }
    const out = await logout({ request: logoutReq({ "sec-fetch-site": site }), env });
    assert.equal(out.status, 403, site);
    assert.equal(out.headers.get("set-cookie"), null);
  }
});

test("missing Origin with Sec-Fetch-Site same-origin or none, or no headers, is accepted", async () => {
  for (const headers of [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, {}]) {
    const restore = mockGuide();
    try {
      assert.equal((await login({ request: loginReq(headers), env })).status, 200);
    } finally { restore(); }
    assert.equal((await logout({ request: logoutReq(headers), env })).status, 200);
  }
});

test("login rejects a form-encoded or text/plain body", async () => {
  for (const type of ["application/x-www-form-urlencoded", "text/plain", null]) {
    const restore = mockGuide();
    try {
      const res = await login({ request: loginReq({ origin: "https://otratickets.com" }, { type }), env });
      assert.equal(res.status, 415, String(type));
      assert.deepEqual(await res.json(), { error: "unsupported media type" });
      assert.equal(res.headers.get("set-cookie"), null);
      assert.equal(restore.calls, 0);
    } finally { restore(); }
  }
  const restore = mockGuide();
  try {
    const res = await login({ request: loginReq({ origin: "https://otratickets.com" }, { type: "application/json; charset=utf-8" }), env });
    assert.equal(res.status, 200);
  } finally { restore(); }
});

test("a cross-site Origin is refused before the body type is checked", async () => {
  const res = await login({ request: loginReq({ origin: "https://evil.example" }, { type: "text/plain" }), env });
  assert.equal(res.status, 403);
});

test("Origin null is rejected", async () => {
  const restore = mockGuide();
  try {
    assert.equal((await login({ request: loginReq({ origin: "null" }), env })).status, 403);
    assert.equal(restore.calls, 0);
  } finally { restore(); }
  assert.equal((await logout({ request: logoutReq({ origin: "null" }), env })).status, 403);
});

test("localhost origin is accepted only when the request host is localhost", async () => {
  for (const origin of ["http://localhost:8788", "http://127.0.0.1:8790"]) {
    const local = new URL(origin).host;
    const restore = mockGuide();
    try {
      const ok = await login({ request: loginReq({ origin }, { url: `http://${local}/api/login` }), env });
      assert.equal(ok.status, 200, origin);
      const prod = await login({ request: loginReq({ origin }), env });
      assert.equal(prod.status, 403, `${origin} against production host`);
    } finally { restore(); }
    assert.equal((await logout({ request: logoutReq({ origin }, `http://${local}/api/logout`), env })).status, 200);
    assert.equal((await logout({ request: logoutReq({ origin }), env })).status, 403);
  }
});

test("Guide 429 shows the rate-limit message", async () => {
  const restore = mockGuide({ tokenStatus: 429 });
  try {
    const res = await login({ request: loginReq({ origin: "https://otratickets.com" }), env });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: "Too many attempts. Try again in a few minutes." });
    assert.equal(res.headers.get("set-cookie"), null);
  } finally { restore(); }
});
