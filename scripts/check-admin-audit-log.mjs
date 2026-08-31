#!/usr/bin/env node
// Oracle: admin override saves and media uploads append a KV audit log, and
// the editor History view can read it. Audit failures never fail the save.
// Run: node scripts/check-admin-audit-log.mjs

import fs from "node:fs";
import { URL } from "node:url";
import { onRequestGet as onAuditGet } from "../functions/admin/api/audit.js";
import { onRequestPut as onOverridePut } from "../functions/admin/api/overrides.js";
import { onRequestPost as onUploadPost } from "../functions/admin/api/upload.js";
import { AUDIT_CAP, auditKey } from "../functions/admin/api/_audit.js";

const html = fs.readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

assert(/id="historyPanel"/.test(html), "admin History panel markup must exist");
assert(/id="historyList"/.test(html), "admin History list markup must exist");
assert(/id="historyBtn"/.test(html), "admin History button must exist");
assert(/\/admin\/api\/audit\?id=/.test(html), "admin must fetch /admin/api/audit for the selected page");
assert(/function loadPageHistory\(/.test(html), "loadPageHistory must exist");
assert(/function toggleHistory\(/.test(html), "toggleHistory must exist");
assert(/\.app\.show-history/.test(html), "opening History must give the preview grid an extra auto row");
assert(
  /@media \(max-width: 980px\) \{[\s\S]*\.history-panel/.test(html),
  "History padding must tighten on the same 980px wrap breakpoint as the topbar"
);
assert(!/figma|drive\.google|New task template/i.test(html), "History must not add Drive, Figma, or task template blocks");

function makeKv(records = {}, options = {}) {
  const store = new Map(
    Object.entries(records).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)])
  );
  const puts = [];
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      puts.push(key);
      if (options.failAudit && String(key).startsWith("audit:")) {
        throw new Error("audit kv down");
      }
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix } = {}) {
      const keys = [...store.keys()]
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    store,
    puts,
  };
}

function jwtFor(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function staffFetch(role = { is_staff_or_admin: true, email: "tjscott@me.com", username: "tj" }) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/users/user-role/")) {
      return { ok: true, json: async () => role };
    }
    return { ok: true, json: async () => ({}) };
  };
  return () => {
    globalThis.fetch = real;
  };
}

async function call(handler, request, env) {
  const restore = staffFetch(env.role);
  try {
    const response = await handler({ request, env });
    const body = await response.json();
    return { status: response.status, body };
  } finally {
    restore();
  }
}

function staffRequest(url, init = {}) {
  const { token: tokenOpt, ...rest } = init;
  const token = tokenOpt === undefined ? jwtFor({ user_id: 99 }) : tokenOpt;
  const headers = new Headers(rest.headers || {});
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { ...rest, headers });
}

const PAGE = "6113";

{
  const { status, body } = await call(
    onAuditGet,
    new Request("https://otratickets.com/admin/api/audit?id=" + PAGE),
    { role: { is_staff_or_admin: true } }
  );
  assert(status === 401, `missing auth must 401 (got ${status})`);
  assert(body.error === "unauthorized", "missing auth body must say unauthorized");
}

{
  const { status } = await call(
    onAuditGet,
    staffRequest("https://otratickets.com/admin/api/audit?id=" + PAGE),
    { role: { is_staff_or_admin: false } }
  );
  assert(status === 401, `non-staff must 401 (got ${status})`);
}

{
  const { status, body } = await call(
    onAuditGet,
    staffRequest("https://otratickets.com/admin/api/audit?id=" + PAGE),
    { role: { is_staff_or_admin: true } }
  );
  assert(status === 503, `missing KV must 503 (got ${status})`);
  assert(body.error === "overrides store not configured", "missing KV must name the overrides store");
}

for (const id of ["", "nope", "../etc", "event:6113"]) {
  const url = "https://otratickets.com/admin/api/audit" + (id ? `?id=${encodeURIComponent(id)}` : "");
  const { status, body } = await call(onAuditGet, staffRequest(url), {
    OVERRIDES: makeKv(),
    role: { is_staff_or_admin: true },
  });
  assert(status === 400, `invalid id ${JSON.stringify(id)} must 400 (got ${status})`);
  assert(body.error === "invalid id", `invalid id ${JSON.stringify(id)} must say invalid id`);
}

{
  const kv = makeKv();
  const { status, body } = await call(
    onAuditGet,
    staffRequest("https://otratickets.com/admin/api/audit?id=" + PAGE),
    { OVERRIDES: kv, role: { is_staff_or_admin: true } }
  );
  assert(status === 200, `empty history must 200 (got ${status})`);
  assert(Array.isArray(body.entries) && body.entries.length === 0, "empty history must return []");
}

{
  const kv = makeKv();
  const first = await call(
    onOverridePut,
    staffRequest("https://otratickets.com/admin/api/overrides?id=" + PAGE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "Sunday Social hero copy",
        image: "/override-images/sunday.jpg",
        checkoutEventId: "6113",
        accentColor: "#1c9ebd",
        fields: { "text:#evTitle": { type: "text", value: "Sunday Social" } },
      }),
    }),
    { OVERRIDES: kv, role: { is_staff_or_admin: true, email: "tjscott@me.com", username: "tj" } }
  );
  assert(first.status === 200, `first save must succeed (got ${first.status})`);
  const listed = await call(
    onAuditGet,
    staffRequest("https://otratickets.com/admin/api/audit?id=" + PAGE),
    { OVERRIDES: kv, role: { is_staff_or_admin: true } }
  );
  assert(listed.status === 200, "history after first save must 200");
  assert(listed.body.entries.length === 1, "first save must create one audit entry");
  const entry = listed.body.entries[0];
  assert(entry.action === "save", "first save action must be save");
  assert(entry.pageId === PAGE, "first save must record the page id");
  assert(typeof entry.at === "string" && entry.at.includes("T"), "first save must record an ISO timestamp");
  assert(entry.actor && entry.actor.userId === "99", "actor userId must come from the JWT");
  assert(entry.actor.email === "tjscott@me.com", "actor email must come from user-role");
  assert(entry.actor.username === "tj", "actor username must come from user-role");
  assert(!entry.actor.label, "named actor must not fall back to staff");
  const changed = entry.changedFields || [];
  assert(changed.includes("description"), "first save must list description");
  assert(changed.includes("image"), "first save must list image");
  assert(changed.includes("checkoutEventId"), "first save must list checkoutEventId");
  assert(changed.includes("accentColor"), "first save must list accentColor");
  assert(changed.some((key) => key.startsWith("fields.")), "first save must list the title field");

  const second = await call(
    onOverridePut,
    staffRequest("https://otratickets.com/admin/api/overrides?id=" + PAGE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "Sunday Social updated copy",
        image: "/override-images/sunday.jpg",
        checkoutEventId: "6113",
        accentColor: "#1c9ebd",
        fields: { "text:#evTitle": { type: "text", value: "Sunday Social" } },
      }),
    }),
    { OVERRIDES: kv, role: { is_staff_or_admin: true, email: "tjscott@me.com", username: "tj" } }
  );
  assert(second.status === 200, `second save must succeed (got ${second.status})`);
  const afterSecond = await call(
    onAuditGet,
    staffRequest("https://otratickets.com/admin/api/audit?id=" + PAGE),
    { OVERRIDES: kv, role: { is_staff_or_admin: true } }
  );
  assert(afterSecond.body.entries.length === 2, "second save must append a second entry");
  assert(afterSecond.body.entries[0].at >= afterSecond.body.entries[1].at, "GET must return newest first");
  assert(
    JSON.stringify(afterSecond.body.entries[0].changedFields) === JSON.stringify(["description"]),
    `second save must record only description (got ${JSON.stringify(afterSecond.body.entries[0].changedFields)})`
  );

  const third = await call(
    onOverridePut,
    staffRequest("https://otratickets.com/admin/api/overrides?id=" + PAGE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "Sunday Social updated copy",
        image: "/override-images/sunday.jpg",
        checkoutEventId: "6113",
        accentColor: "#1c9ebd",
        fields: { "text:#evTitle": { type: "text", value: "Sunday Social" } },
      }),
    }),
    { OVERRIDES: kv, role: { is_staff_or_admin: true, email: "tjscott@me.com", username: "tj" } }
  );
  assert(third.status === 200, "unchanged PUT must still save");
  const afterThird = await call(
    onAuditGet,
    staffRequest("https://otratickets.com/admin/api/audit?id=" + PAGE),
    { OVERRIDES: kv, role: { is_staff_or_admin: true } }
  );
  assert(afterThird.body.entries.length === 3, "unchanged PUT must still record a save");
  assert(
    Array.isArray(afterThird.body.entries[0].changedFields) && afterThird.body.entries[0].changedFields.length === 0,
    "unchanged PUT must record an empty changedFields list"
  );
}

{
  const kv = makeKv();
  const file = new File([new Uint8Array([1, 2, 3, 4])], "sunday-social.jpg", { type: "image/jpeg" });
  const form = new FormData();
  form.set("id", PAGE);
  form.set("file", file);
  const uploaded = await call(
    onUploadPost,
    staffRequest("https://otratickets.com/admin/api/upload", { method: "POST", body: form }),
    { OVERRIDES: kv, role: { is_staff_or_admin: true, email: "tjscott@me.com" } }
  );
  assert(uploaded.status === 200, `upload must succeed (got ${uploaded.status})`);
  const listed = await call(
    onAuditGet,
    staffRequest("https://otratickets.com/admin/api/audit?id=" + PAGE),
    { OVERRIDES: kv, role: { is_staff_or_admin: true } }
  );
  assert(listed.body.entries.length === 1, "upload must create one audit entry");
  const entry = listed.body.entries[0];
  assert(entry.action === "upload", "upload action must be upload");
  assert(entry.file && entry.file.name === "sunday-social.jpg", "upload must record the file name");
  assert(entry.file.key && entry.file.key.startsWith(PAGE + "/"), "upload must record the storage key, not bytes");
  assert(entry.file.contentType === "image/jpeg", "upload must record the content type");
  const raw = kv.store.get(auditKey(PAGE));
  assert(!String(raw).includes("data:"), "audit log must not store file bytes or data URLs");
  assert(!String(raw).includes("AAAA"), "audit log must not store base64 payloads");
}

{
  const kv = makeKv({}, { failAudit: true });
  const saved = await call(
    onOverridePut,
    staffRequest("https://otratickets.com/admin/api/overrides?id=" + PAGE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "still saved" }),
    }),
    { OVERRIDES: kv, role: { is_staff_or_admin: true } }
  );
  assert(saved.status === 200, `audit failure must not 500 the save (got ${saved.status})`);
  assert(saved.body.override && saved.body.override.description === "still saved", "save body must still include the override");
  const stored = kv.store.get(`event:${PAGE}`);
  assert(stored && stored.includes("still saved"), "override must be written even when audit put throws");
}

{
  const kv = makeKv();
  for (let i = 0; i < AUDIT_CAP + 5; i += 1) {
    const result = await call(
      onOverridePut,
      staffRequest("https://otratickets.com/admin/api/overrides?id=" + PAGE, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: `edit ${i}` }),
      }),
      { OVERRIDES: kv, role: { is_staff_or_admin: true } }
    );
    assert(result.status === 200, `cap save ${i} must succeed`);
  }
  const listed = await call(
    onAuditGet,
    staffRequest("https://otratickets.com/admin/api/audit?id=" + PAGE),
    { OVERRIDES: kv, role: { is_staff_or_admin: true } }
  );
  assert(listed.body.entries.length === AUDIT_CAP, `cap must stay at ${AUDIT_CAP} (got ${listed.body.entries.length})`);
  assert(listed.body.entries[0].changedFields.includes("description"), "newest cap entry must be the latest description change");
  assert(JSON.parse(kv.store.get(`event:${PAGE}`)).description === `edit ${AUDIT_CAP + 4}`, "override itself still holds the latest save");
}

{
  const kv = makeKv();
  const saved = await call(
    onOverridePut,
    staffRequest("https://otratickets.com/admin/api/overrides?id=" + PAGE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      token: "not-a-jwt",
      body: JSON.stringify({ description: "anonymous staff" }),
    }),
    { OVERRIDES: kv, role: { is_staff_or_admin: true } }
  );
  assert(saved.status === 200, "save with a non-JWT staff token must still work");
  const listed = await call(
    onAuditGet,
    staffRequest("https://otratickets.com/admin/api/audit?id=" + PAGE, { token: "not-a-jwt" }),
    { OVERRIDES: kv, role: { is_staff_or_admin: true } }
  );
  assert(listed.body.entries[0].actor.label === "staff", "missing JWT claims must fall back to staff, never invent a name");
  assert(!listed.body.entries[0].actor.email, "fallback actor must not invent an email");
}

if (failures.length) {
  console.error(`check-admin-audit-log: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("check-admin-audit-log: all assertions passed");
