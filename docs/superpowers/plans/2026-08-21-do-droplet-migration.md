# otratickets.com DO Droplet Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve otratickets.com from a dedicated DigitalOcean droplet (Otra Guide team, nyc3) running the repo's existing Cloudflare Pages functions through a Node compatibility layer, with KV in managed Postgres, media in Spaces, GitHub Actions deploys, and same-day DNS cutover.

**Architecture:** Caddy terminates TLS and proxies everything to a Node 22 service that routes requests to the untouched `functions/` modules via Pages-convention routing, backed by shims: Postgres for the `OVERRIDES` KV binding, Spaces (S3) for the `OVERRIDE_IMAGES` R2 binding, and a `dist/` file server for `ASSETS`. Cloudflare keeps DNS + proxy; rollback is one DNS flip back to Pages.

**Tech Stack:** Node 22 (native fetch/Request/Response/FormData, node:test), `pg`, `@aws-sdk/client-s3`, Caddy 2, systemd, doctl, Cloudflare REST API, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-21-do-droplet-migration-design.md`

## Global Constraints

- Never use em-dashes or en-dashes in any file, commit message, or document. ASCII only in scripts.
- Shell scripts start with `#!/usr/bin/env bash`, never `#!/bin/bash`.
- `functions/` code is NOT modified by this migration. Shims adapt to it, never the reverse.
- Everything DO lives on the **Otra Guide team** (doctl context `otra-guide`, already the default). Region **nyc3** only.
- Names locked by spec: droplet `otratickets-web-1`, Postgres logical db + user `otratickets`, Space `otratickets-media`, systemd unit `otratickets`, code at `/srv/otratickets`, Node service on `127.0.0.1:8788`.
- VPC: `otraguide-nyc3` = `22422c51-0979-4ea5-a6fd-5313aed983ab`. SSH key: `brian-do-production` id `55555158`.
- Postgres cluster `otraguide-nyc-pg` = `17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb`. NEVER touch its existing databases, users, or firewall rules belonging to otraguide. Trusted-source rules are APPENDED, and ONLY if the rule list is already non-empty (an append to an empty list would lock out otraguide.com).
- Cloudflare credentials come from the local environment (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). All Cloudflare reads/writes for migration are scoped to the otratickets Pages project and the otratickets.com zone. Never touch other zones.
- Cloudflare Pages project, its KV namespace, and its R2 bucket are read-only throughout and stay alive after cutover (rollback target).
- Commit after each task on branch `infra/do-droplet-migration`. Do not push (repo delivery is via PR at the end; Brian confirms).
- Secrets never enter the repo. Droplet secrets live in `/etc/otratickets/env`; local scratch secrets in the session scratchpad, not the project tree.
- Server tests run with `node --test server/test/` and must not require network or real credentials.

---

### Task 1: Provision DO infrastructure

**Files:**
- Create: `deploy/provisioning-notes.md` (records IDs/IPs produced here; no secrets)

**Interfaces:**
- Produces: running droplet `otratickets-web-1` (records its public IP as `DROPLET_IP` and droplet ID), Postgres logical db+user `otratickets` with connection URI (private host), Space `otratickets-media` with a bucket-scoped key pair, firewall `otratickets-fw`. Secrets written to scratchpad file `do-secrets.env` for Task 6, never committed.

- [ ] **Step 1: Create the droplet**

```bash
doctl compute droplet create otratickets-web-1 \
  --region nyc3 --size s-1vcpu-2gb --image ubuntu-24-04-x64 \
  --vpc-uuid 22422c51-0979-4ea5-a6fd-5313aed983ab \
  --ssh-keys 55555158 --enable-backups --enable-monitoring \
  --tag-name otratickets --wait \
  --format ID,Name,PublicIPv4,Region,Status
```

Record ID and PublicIPv4. Verify status `active`.

- [ ] **Step 2: Create the firewall and attach by tag**

```bash
doctl compute firewall create --name otratickets-fw \
  --tag-names otratickets \
  --inbound-rules "protocol:tcp,ports:22,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0"
```

- [ ] **Step 3: Postgres logical database and user**

```bash
doctl databases db create 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb otratickets
doctl databases user create 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb otratickets
doctl databases connection 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb --format URI
doctl databases get 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb --format Connection.PrivateHost 2>/dev/null || doctl databases get 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb -o json | python -c "import json,sys; d=json.load(sys.stdin); print(d[0]['private_connection']['host'])"
```

The user create output prints the password once; store it in the scratchpad `do-secrets.env` as `PG_PASSWORD=...` along with `PG_PRIVATE_HOST=...` and the doadmin URI as `PG_ADMIN_URI=...`.

- [ ] **Step 4: Grant the user privileges on the new database**

psql may not be installed locally; use a Node one-liner with pg (available after Task 4's `npm ci` in `server/`; if running Task 1 first, `npm --prefix server init -y >/dev/null && npm --prefix server i pg` in a scratch copy, or simply run this from any directory with `npx -y pg-cli` avoided; prefer the plain node script below with a temporary `npm i pg` inside the scratchpad):

```bash
cd "$SCRATCHPAD" && npm init -y >/dev/null 2>&1 && npm i pg >/dev/null 2>&1
node - <<'EOF'
const { Client } = require("pg");
const adminUri = process.env.PG_ADMIN_URI; // doadmin URI from Step 3, pointed at db otratickets
const url = new URL(adminUri);
url.pathname = "/otratickets";
const c = new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  await c.query('GRANT ALL PRIVILEGES ON DATABASE otratickets TO otratickets');
  await c.query('GRANT ALL ON SCHEMA public TO otratickets');
  await c.end();
  console.log("grants ok");
})().catch(e => { console.error(e.message); process.exit(1); });
EOF
```

- [ ] **Step 5: Append droplet to cluster trusted sources ONLY if rules already exist**

```bash
doctl databases firewalls list 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb
```

If the list is NON-EMPTY: `doctl databases firewalls append 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb --rule droplet:<DROPLET_ID>`. If EMPTY: do nothing (cluster is open; adding a first rule would cut off otraguide.com) and record that fact in `deploy/provisioning-notes.md`.

- [ ] **Step 6: Create Spaces bucket and scoped key**

```bash
doctl spaces keys create otratickets-bootstrap --grants "bucket=;permission=fullaccess"
```

Record the access/secret pair (shown once) in scratchpad. Then create the bucket with the AWS CLI if present (`command -v aws`), else with a Node script using `@aws-sdk/client-s3` from the scratchpad install:

```bash
AWS_ACCESS_KEY_ID=<bootstrap-key> AWS_SECRET_ACCESS_KEY=<bootstrap-secret> \
aws s3api create-bucket --bucket otratickets-media \
  --endpoint-url https://nyc3.digitaloceanspaces.com --region us-east-1
```

Then the scoped runtime key:

```bash
doctl spaces keys create otratickets-media-rw --grants "bucket=otratickets-media;permission=readwrite"
```

Record as `SPACES_KEY` / `SPACES_SECRET` in scratchpad `do-secrets.env`. Delete the bootstrap key: `doctl spaces keys list` then `doctl spaces keys delete <bootstrap-key-id>` (verify name matches otratickets-bootstrap before deleting).

- [ ] **Step 7: Download the cluster CA certificate**

```bash
doctl databases get-ca 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb -o json | python -c "import json,sys;print(json.load(sys.stdin)[0]['certificate'])" | base64 -d > "$SCRATCHPAD/pg-ca.crt" 2>/dev/null || doctl databases get-ca 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb
```

Whichever form works, end with a PEM file `pg-ca.crt` in the scratchpad.

- [ ] **Step 8: Verify and record**

```bash
doctl compute droplet get otratickets-web-1 --format Name,PublicIPv4,Status
doctl databases db list 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb | grep otratickets
doctl spaces keys list | grep otratickets-media-rw
```

Write `deploy/provisioning-notes.md` with droplet ID/IP, firewall name, db/user names, bucket name, key NAME only (no secrets), and the trusted-sources decision from Step 5. Commit:

```bash
git add deploy/provisioning-notes.md && git commit -m "infra: provision otratickets-web-1 droplet, db, and media bucket (notes)"
```

---

### Task 2: Server core: route table + resolver (pure logic)

**Files:**
- Create: `server/router.js`
- Test: `server/test/router.test.mjs`
- Create: `server/package.json`

**Interfaces:**
- Produces: `buildRouteTable(fileList)` -> array of route entries `{ pattern, segments, modulePath, kind }`; `resolveRoute(routes, pathname)` -> `{ modulePath, params } | null`. Pure functions, no fs, no imports of function modules.
- Consumed by Task 5 (dispatcher imports the resolved module and picks `onRequest<Method>`).

Routing rules (Cloudflare Pages conventions, matching this repo's `functions/` tree exactly):
- A file `functions/api/homepage-events.js` serves exactly `/api/homepage-events`.
- `functions/[slug].js` serves any SINGLE top-level segment, param `slug` (decoded). It must NOT match `/` (empty) and must NOT match paths with more than one segment.
- `functions/override-images/[[path]].js` serves `/override-images/<anything, any depth>`, param `path` = array of decoded segments.
- Files under `functions/_lib/` and files starting with `_` (like `admin/api/_auth.js`) are never routed.
- Specificity: exact static match wins over `[param]`, which wins over `[[catchall]]`; deeper static paths win over shallower catch-alls.

- [ ] **Step 1: server/package.json**

```json
{
  "name": "otratickets-server",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": { "test": "node --test server/test/" },
  "dependencies": {
    "pg": "^8.12.0",
    "@aws-sdk/client-s3": "^3.600.0"
  }
}
```

Place at `server/package.json`. Run `npm --prefix server install` to create `server/package-lock.json`.

- [ ] **Step 2: Write the failing test**

`server/test/router.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRouteTable, resolveRoute } from "../router.js";

const FILES = [
  "[slug].js", "sitemap.xml.js", "robots.txt.js", "llms.txt.js",
  "_lib/homepage-feed.js", "admin/api/_auth.js", "admin/api/login.js",
  "admin/api/events.js", "api/homepage-events.js",
  "override-images/[[path]].js", "override-media/[[path]].js",
];
const routes = buildRouteTable(FILES);

test("static route wins", () => {
  assert.deepEqual(resolveRoute(routes, "/api/homepage-events"),
    { modulePath: "api/homepage-events.js", params: {} });
});
test("slug matches single segment only", () => {
  assert.deepEqual(resolveRoute(routes, "/kaya-kaya"),
    { modulePath: "[slug].js", params: { slug: "kaya-kaya" } });
  assert.equal(resolveRoute(routes, "/"), null);
  assert.equal(resolveRoute(routes, "/a/b"), null);
});
test("catchall collects segments", () => {
  assert.deepEqual(resolveRoute(routes, "/override-images/x/y.png"),
    { modulePath: "override-images/[[path]].js", params: { path: ["x", "y.png"] } });
});
test("underscore files are not routed", () => {
  assert.equal(resolveRoute(routes, "/admin/api/_auth"), null);
  const hit = resolveRoute(routes, "/admin/api/login");
  assert.equal(hit.modulePath, "admin/api/login.js");
});
test("static file names with dots route exactly", () => {
  assert.equal(resolveRoute(routes, "/sitemap.xml").modulePath, "sitemap.xml.js");
});
test("decodes percent-encoding in params", () => {
  assert.deepEqual(resolveRoute(routes, "/caf%C3%A9").params, { slug: "café" });
});
```

- [ ] **Step 3: Run to verify it fails** — `node --test server/test/router.test.mjs` expecting module-not-found.

- [ ] **Step 4: Implement `server/router.js`**

```js
// Pages-convention router over a functions/ file listing. Pure logic.
export function buildRouteTable(fileList) {
  const routes = [];
  for (const rel of fileList) {
    if (!rel.endsWith(".js")) continue;
    const parts = rel.split("/");
    if (parts.some((p) => p.startsWith("_"))) continue;
    const base = parts.pop().slice(0, -3); // drop .js
    const segments = [...parts, base].map((seg) => {
      if (seg.startsWith("[[") && seg.endsWith("]]"))
        return { kind: "catchall", name: seg.slice(2, -2) };
      if (seg.startsWith("[") && seg.endsWith("]"))
        return { kind: "param", name: seg.slice(1, -1) };
      return { kind: "static", value: seg };
    });
    routes.push({ modulePath: rel, segments });
  }
  // Most-specific first: more static segments, then fewer dynamic ones.
  routes.sort((a, b) => score(b) - score(a));
  return routes;
}
function score(route) {
  let s = 0;
  for (const seg of route.segments) {
    if (seg.kind === "static") s += 100;
    else if (seg.kind === "param") s += 10;
    else s += 1;
  }
  return s;
}
export function resolveRoute(routes, pathname) {
  const segs = pathname.split("/").filter((s) => s !== "").map(decodeURIComponent);
  outer: for (const route of routes) {
    const params = {};
    let i = 0;
    for (let r = 0; r < route.segments.length; r++) {
      const pat = route.segments[r];
      if (pat.kind === "catchall") {
        if (r !== route.segments.length - 1) continue outer;
        params[pat.name] = segs.slice(i);
        return { modulePath: route.modulePath, params };
      }
      if (i >= segs.length) continue outer;
      if (pat.kind === "static") {
        if (segs[i] !== pat.value) continue outer;
      } else {
        params[pat.name] = segs[i];
      }
      i++;
    }
    if (i !== segs.length) continue outer;
    return { modulePath: route.modulePath, params };
  }
  return null;
}
```

Note the empty-path rule: `/` produces zero segments; `[slug].js` has one param segment which cannot bind, so it correctly returns null (falls to ASSETS).

- [ ] **Step 5: Run tests, verify PASS** — `node --test server/test/router.test.mjs`

- [ ] **Step 6: Commit** — `git add server/ && git commit -m "feat(server): Pages-convention route resolver"`

---

### Task 3: KV shim on Postgres

**Files:**
- Create: `server/kv.js`, `server/schema.sql`
- Test: `server/test/kv.test.mjs`

**Interfaces:**
- Produces: `createKv(pool)` -> object with `get(key, type?)`, `getWithMetadata(key, type?)`, `put(key, value, opts?)`, `delete(key)`, `list({ prefix, cursor, limit }?)`. `pool` is anything with `query(text, params) -> { rows }` (real `pg.Pool` in prod, stub in tests).
- Semantics must match what `functions/` uses: `get(k)` -> string or null; `get(k, "json")` -> parsed or null when missing; `getWithMetadata(k, "arrayBuffer")` -> `{ value: ArrayBuffer|null, metadata: object|null }`; `put` accepts string | ArrayBuffer | Uint8Array with optional `{ metadata }`; `list` -> `{ keys: [{ name, metadata }], list_complete, cursor }` with default limit 1000.

- [ ] **Step 1: schema.sql**

```sql
CREATE TABLE IF NOT EXISTS kv (
  key        text PRIMARY KEY,
  value      bytea NOT NULL,
  metadata   jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Failing test** `server/test/kv.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKv } from "../kv.js";

function stubPool() {
  const store = new Map(); // key -> {value: Buffer, metadata}
  return {
    store,
    async query(text, params = []) {
      if (/INSERT INTO kv/.test(text)) {
        store.set(params[0], { value: params[1], metadata: params[2] ? JSON.parse(params[2]) : null });
        return { rows: [] };
      }
      if (/DELETE FROM kv/.test(text)) { store.delete(params[0]); return { rows: [] }; }
      if (/SELECT key, metadata FROM kv/.test(text)) {
        const [prefix, after, limit] = params;
        const keys = [...store.keys()].filter(k => k.startsWith(prefix) && k > after).sort().slice(0, limit);
        return { rows: keys.map(k => ({ key: k, metadata: store.get(k).metadata })) };
      }
      if (/SELECT value, metadata FROM kv/.test(text)) {
        const hit = store.get(params[0]);
        return { rows: hit ? [{ value: hit.value, metadata: hit.metadata }] : [] };
      }
      throw new Error("unexpected sql: " + text);
    },
  };
}

test("get returns null when missing, text by default, json parses", async () => {
  const kv = createKv(stubPool());
  assert.equal(await kv.get("nope"), null);
  await kv.put("a", JSON.stringify({ x: 1 }));
  assert.equal(typeof await kv.get("a"), "string");
  assert.deepEqual(await kv.get("a", "json"), { x: 1 });
});
test("binary round-trip with metadata", async () => {
  const kv = createKv(stubPool());
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  await kv.put("img", bytes, { metadata: { storage: "binary", contentType: "image/png" } });
  const got = await kv.getWithMetadata("img", "arrayBuffer");
  assert.deepEqual(new Uint8Array(got.value), new Uint8Array([1, 2, 3]));
  assert.equal(got.metadata.contentType, "image/png");
});
test("list honors prefix and cursor pagination", async () => {
  const kv = createKv(stubPool());
  for (const k of ["site-event:1", "site-event:2", "site-event:3", "other:x"]) await kv.put(k, "v");
  const p1 = await kv.list({ prefix: "site-event:", limit: 2 });
  assert.deepEqual(p1.keys.map(k => k.name), ["site-event:1", "site-event:2"]);
  assert.equal(p1.list_complete, false);
  const p2 = await kv.list({ prefix: "site-event:", cursor: p1.cursor, limit: 2 });
  assert.deepEqual(p2.keys.map(k => k.name), ["site-event:3"]);
  assert.equal(p2.list_complete, true);
});
test("delete removes", async () => {
  const kv = createKv(stubPool());
  await kv.put("k", "v"); await kv.delete("k");
  assert.equal(await kv.get("k"), null);
});
```

- [ ] **Step 3: Run, verify FAIL** — `node --test server/test/kv.test.mjs`

- [ ] **Step 4: Implement `server/kv.js`**

```js
// Cloudflare KV compatibility over Postgres. See schema.sql.
export function createKv(pool) {
  async function read(key) {
    const { rows } = await pool.query(
      "SELECT value, metadata FROM kv WHERE key = $1", [key]);
    return rows[0] || null;
  }
  function decode(row, type) {
    if (!row) return null;
    const buf = row.value; // Buffer
    if (type === "arrayBuffer")
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const text = buf.toString("utf8");
    if (type === "json") { try { return JSON.parse(text); } catch { return null; } }
    return text;
  }
  return {
    async get(key, type) { return decode(await read(key), type); },
    async getWithMetadata(key, type) {
      const row = await read(key);
      return { value: decode(row, type), metadata: row ? row.metadata : null };
    },
    async put(key, value, opts = {}) {
      let buf;
      if (typeof value === "string") buf = Buffer.from(value, "utf8");
      else if (value instanceof ArrayBuffer) buf = Buffer.from(value);
      else if (ArrayBuffer.isView(value)) buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      else if (value && typeof value.arrayBuffer === "function") buf = Buffer.from(await value.arrayBuffer());
      else if (value && typeof value.getReader === "function") {
        const chunks = [];
        for await (const c of value) chunks.push(c);
        buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      } else throw new Error("kv.put: unsupported value type");
      const meta = opts.metadata ? JSON.stringify(opts.metadata) : null;
      await pool.query(
        `INSERT INTO kv (key, value, metadata, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, metadata = $3, updated_at = now()`,
        [key, buf, meta]);
    },
    async delete(key) { await pool.query("DELETE FROM kv WHERE key = $1", [key]); },
    async list({ prefix = "", cursor = "", limit = 1000 } = {}) {
      const after = cursor ? Buffer.from(cursor, "base64").toString("utf8") : "";
      const { rows } = await pool.query(
        `SELECT key, metadata FROM kv WHERE key LIKE $1 || '%' AND key > $2 ORDER BY key LIMIT $3`,
        [prefix, after, limit + 1]);
      const page = rows.slice(0, limit);
      const complete = rows.length <= limit;
      return {
        keys: page.map((r) => ({ name: r.key, metadata: r.metadata })),
        list_complete: complete,
        cursor: complete ? undefined : Buffer.from(page[page.length - 1].key, "utf8").toString("base64"),
      };
    },
  };
}
```

Note: the stub's list branch ignores the limit+1 lookahead nuance; adjust the stub filter to `slice(0, limit)` on the LIMIT param it receives (the implementation passes `limit + 1`), and assert on `list_complete` accordingly (the test above already does: with limit 2 the first call sees 3 matches, lookahead makes `list_complete` false).

- [ ] **Step 5: Run tests, verify PASS** — `node --test server/test/kv.test.mjs`

- [ ] **Step 6: Commit** — `git add server/ && git commit -m "feat(server): Postgres-backed Cloudflare KV shim"`

---

### Task 4: R2 shim on Spaces and ASSETS shim over dist/

**Files:**
- Create: `server/r2.js`, `server/assets.js`
- Test: `server/test/r2.test.mjs`, `server/test/assets.test.mjs`

**Interfaces:**
- Produces: `createBucket(s3, bucketName)` with `put(key, value, opts?)` (opts.httpMetadata.contentType honored) and `get(key, opts?)` returning `null` on miss or `{ key, size, etag, body, httpMetadata: { contentType }, writeHttpMetadata(headers) }`; `opts.range` accepts Cloudflare shapes `{ offset, length? }` or `{ suffix }`. `s3` is anything with `send(command)` (real S3Client in prod, stub in tests).
- Produces: `createAssets(distDir, headersFile)` with `fetch(requestOrUrl)` -> `Response` (200 with body + content-type, 404 otherwise), applying matching rules from the repo's `_headers` file.
- Before implementing, READ `functions/override-media/[[path]].js` and `functions/override-images/[[path]].js` end to end and match every property they touch on the returned object.

- [ ] **Step 1: Failing tests**

`server/test/r2.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBucket } from "../r2.js";

function stubS3() {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      calls.push(cmd);
      const name = cmd.constructor.name;
      if (name === "PutObjectCommand") return {};
      if (name === "GetObjectCommand") {
        if (cmd.input.Key === "missing") { const e = new Error("nf"); e.name = "NoSuchKey"; throw e; }
        return {
          Body: { transformToWebStream: () => "stream-sentinel" },
          ContentType: "image/webp", ContentLength: 5, ETag: '"abc"',
          _range: cmd.input.Range,
        };
      }
      throw new Error("unexpected " + name);
    },
  };
}

test("put passes bucket, key, body, content type", async () => {
  const s3 = stubS3();
  const b = createBucket(s3, "otratickets-media");
  await b.put("a/b.webp", "bytes", { httpMetadata: { contentType: "image/webp" } });
  const input = s3.calls[0].input;
  assert.equal(input.Bucket, "otratickets-media");
  assert.equal(input.Key, "a/b.webp");
  assert.equal(input.ContentType, "image/webp");
});
test("get returns null on miss and object on hit", async () => {
  const b = createBucket(stubS3(), "m");
  assert.equal(await b.get("missing"), null);
  const obj = await b.get("hit.webp");
  assert.equal(obj.httpMetadata.contentType, "image/webp");
  assert.equal(obj.size, 5);
  const h = new Headers(); obj.writeHttpMetadata(h);
  assert.equal(h.get("content-type"), "image/webp");
});
test("range shapes convert to S3 Range header", async () => {
  const s3 = stubS3();
  const b = createBucket(s3, "m");
  await b.get("hit", { range: { offset: 10, length: 5 } });
  assert.equal(s3.calls[0].input.Range, "bytes=10-14");
  await b.get("hit", { range: { offset: 10 } });
  assert.equal(s3.calls[1].input.Range, "bytes=10-");
  await b.get("hit", { range: { suffix: 100 } });
  assert.equal(s3.calls[2].input.Range, "bytes=-100");
});
```

`server/test/assets.test.mjs` (uses the real repo dist/ and _headers):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssets } from "../assets.js";

const assets = createAssets(new URL("../../dist/", import.meta.url).pathname,
                            new URL("../../_headers", import.meta.url).pathname);

test("serves index.html at root with html content type", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});
test("404 for unknown path", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/definitely-not-here.xyz"));
  assert.equal(res.status, 404);
});
test("no path traversal", async () => {
  const res = await assets.fetch(new Request("https://otratickets.com/..%2f..%2fetc%2fpasswd"));
  assert.notEqual(res.status, 200);
});
test("accepts URL argument form used by [slug].js", async () => {
  const res = await assets.fetch(new URL("/event", "https://otratickets.com/x"));
  assert.equal([200, 404].includes(res.status), true); // 200 if dist/event.html exists
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement `server/r2.js`**

```js
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

function toS3Range(range) {
  if (!range) return undefined;
  if (range.suffix != null) return `bytes=-${range.suffix}`;
  const start = range.offset || 0;
  return range.length != null ? `bytes=${start}-${start + range.length - 1}` : `bytes=${start}-`;
}

export function createBucket(s3, bucketName) {
  return {
    async put(key, value, opts = {}) {
      let body = value;
      if (value && typeof value.getReader === "function") {
        // S3 SDK needs a length; buffer web streams (uploads are small media files).
        const chunks = [];
        for await (const c of value) chunks.push(Buffer.from(c));
        body = Buffer.concat(chunks);
      } else if (value instanceof ArrayBuffer) body = Buffer.from(value);
      await s3.send(new PutObjectCommand({
        Bucket: bucketName, Key: key, Body: body,
        ContentType: opts.httpMetadata && opts.httpMetadata.contentType || undefined,
        CacheControl: opts.httpMetadata && opts.httpMetadata.cacheControl || undefined,
      }));
    },
    async get(key, opts = {}) {
      let out;
      try {
        out = await s3.send(new GetObjectCommand({
          Bucket: bucketName, Key: key, Range: toS3Range(opts.range),
        }));
      } catch (e) {
        if (e.name === "NoSuchKey" || e.$metadata && e.$metadata.httpStatusCode === 404) return null;
        throw e;
      }
      const contentType = out.ContentType || "";
      return {
        key,
        size: out.ContentLength,
        etag: out.ETag,
        body: out.Body && out.Body.transformToWebStream ? out.Body.transformToWebStream() : out.Body,
        httpMetadata: { contentType, cacheControl: out.CacheControl },
        writeHttpMetadata(headers) {
          if (contentType) headers.set("content-type", contentType);
          if (out.CacheControl) headers.set("cache-control", out.CacheControl);
        },
      };
    },
  };
}
```

- [ ] **Step 4: Implement `server/assets.js`**

```js
import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { Readable } from "node:stream";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".gif": "image/gif", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml", ".woff2": "font/woff2", ".woff": "font/woff",
  ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
};

// Minimal Cloudflare Pages _headers parser: blocks of "<path pattern>" then
// indented "Header: value" lines. Supports trailing "*" glob and ":splat"-free
// exact paths, which covers this repo's _headers file. Read the repo file and
// extend only if a rule there needs more.
function parseHeaderRules(file) {
  if (!file || !existsSync(file)) return [];
  const rules = [];
  let current = null;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!raw.startsWith(" ") && !raw.startsWith("\t")) {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const idx = raw.indexOf(":");
      if (idx > 0) current.headers.push([raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()]);
    }
  }
  return rules;
}
function matches(pattern, path) {
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return pattern === path;
}

export function createAssets(distDir, headersFile) {
  const rules = parseHeaderRules(headersFile);
  return {
    async fetch(input) {
      const url = input instanceof URL ? input : new URL(input.url);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Bad Request", { status: 400 }); }
      let rel = normalize(pathname).replace(/^\/+/, "");
      if (rel.includes("..")) return new Response("Not Found", { status: 404 });
      let file = join(distDir, rel === "" ? "index.html" : rel);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file) && !extname(file)) file = file + ".html"; // /event -> event.html
      if (!existsSync(file) || !statSync(file).isFile()) return new Response("Not Found", { status: 404 });
      const headers = new Headers({ "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
      for (const rule of rules)
        if (matches(rule.pattern, pathname))
          for (const [k, v] of rule.headers) headers.set(k, v);
      return new Response(Readable.toWeb(createReadStream(file)), { status: 200, headers });
    },
  };
}
```

Before finalizing, READ the repo's `_headers` file; if it uses placeholders beyond a trailing `*` glob, extend `matches` to cover exactly what appears there.

- [ ] **Step 5: Run all server tests, verify PASS** — `node --test server/test/`

- [ ] **Step 6: Commit** — `git add server/ && git commit -m "feat(server): Spaces R2 shim and dist ASSETS shim"`

---

### Task 5: HTTP adapter, dispatcher, caches polyfill, entrypoint

**Files:**
- Create: `server/app.js` (request handling, exported for tests), `server/index.js` (process entrypoint), `server/cache.js`
- Test: `server/test/app.test.mjs`

**Interfaces:**
- Consumes: `buildRouteTable`/`resolveRoute` (Task 2), `createKv` (Task 3), `createBucket`/`createAssets` (Task 4).
- Produces: `createApp(env, routes, functionsDir)` -> `{ handle(request) -> Promise<{ response, background: Promise[] }> }`; `server/index.js` wires real pool/S3/assets from environment variables `PORT` (default 8788), `DATABASE_URL`, `PGSSLROOTCERT` (path, optional), `SPACES_ENDPOINT`, `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET`, `OTRA_API_URL`, `DIST_DIR` (default `<repo>/dist`).

Key behaviors:
- Build a `Request` from node req with `https` scheme and the Host header (Caddy passes it through), `duplex: "half"` for bodies.
- Dispatch: resolve route; if hit, dynamic-import the module from `functions/` (cache imports), pick `onRequest` + method suffix mapping GET/HEAD->`onRequestGet`, POST->`onRequestPost`, PUT->`onRequestPut`, DELETE->`onRequestDelete`, else generic `onRequest`; if the module lacks a handler for the method, fall through to ASSETS. No route -> ASSETS.
- Context object: `{ request, env, params, waitUntil(p), next: () => env.ASSETS.fetch(request), functionPath }`. Collect `waitUntil` promises and return them as `background` so the caller can `Promise.allSettled` after responding (index.js does this without blocking the response).
- `globalThis.caches` polyfill (`server/cache.js`): `caches.default` and `caches.open(name)` return a shared in-memory cache with `match(key)` -> cloned Response or undefined, honoring stored `cache-control: max-age` for expiry, `put(key, response)` buffering the body, and `delete(key)`. Cap entries (200) with simple oldest-first eviction.
- Errors from handlers -> log with `console.error` and return 500 `Response("Internal Server Error")`.

- [ ] **Step 1: Failing test** `server/test/app.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { buildRouteTable } from "../router.js";

// A miniature functions dir exercising routing, env, params, waitUntil, fallback.
const dir = mkdtempSync(join(tmpdir(), "fx-"));
mkdirSync(join(dir, "api"), { recursive: true });
writeFileSync(join(dir, "api", "ping.js"), `
export async function onRequestGet(ctx) {
  ctx.waitUntil(Promise.resolve().then(() => { globalThis.__bg = true; }));
  return new Response(JSON.stringify({ ok: true, kv: await ctx.env.OVERRIDES.get("k") }),
    { headers: { "content-type": "application/json" } });
}`);
writeFileSync(join(dir, "[slug].js"), `
export async function onRequestGet(ctx) {
  if (ctx.params.slug === "fall") return ctx.env.ASSETS.fetch(ctx.request);
  return new Response("slug:" + ctx.params.slug);
}`);

const env = {
  OVERRIDES: { async get() { return "v"; } },
  ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
};
const routes = buildRouteTable(["api/ping.js", "[slug].js"]);
const app = createApp(env, routes, dir);

test("routes to function and surfaces waitUntil promises", async () => {
  const { response, background } = await app.handle(new Request("https://x.test/api/ping"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, kv: "v" });
  await Promise.allSettled(background);
  assert.equal(globalThis.__bg, true);
});
test("slug param and explicit ASSETS fallback", async () => {
  const a = await app.handle(new Request("https://x.test/hello"));
  assert.equal(await a.response.text(), "slug:hello");
  const b = await app.handle(new Request("https://x.test/fall"));
  assert.equal(await b.response.text(), "asset");
});
test("unrouted path serves assets; wrong method falls to assets", async () => {
  const a = await app.handle(new Request("https://x.test/api/ping/extra"));
  assert.equal(await a.response.text(), "asset");
  const b = await app.handle(new Request("https://x.test/api/ping", { method: "DELETE" }));
  assert.equal(await b.response.text(), "asset");
});
test("handler crash becomes 500", async () => {
  writeFileSync(join(dir, "boom.js"), `export function onRequestGet(){ throw new Error("x"); }`);
  const app2 = createApp(env, buildRouteTable(["boom.js"]), dir);
  const { response } = await app2.handle(new Request("https://x.test/boom"));
  assert.equal(response.status, 500);
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement `server/cache.js`**

```js
// In-memory stand-in for the Workers Cache API. Best-effort: correctness
// does not depend on hits (functions rebuild on miss), only on not serving
// expired entries.
function makeCache() {
  const store = new Map(); // urlKey -> { body: Buffer, status, headers, expires }
  function keyOf(k) { return typeof k === "string" ? k : (k && k.url) || String(k); }
  return {
    async match(k) {
      const hit = store.get(keyOf(k));
      if (!hit) return undefined;
      if (hit.expires && Date.now() > hit.expires) { store.delete(keyOf(k)); return undefined; }
      return new Response(hit.body, { status: hit.status, headers: hit.headers });
    },
    async put(k, response) {
      const body = Buffer.from(await response.clone().arrayBuffer());
      const cc = response.headers.get("cache-control") || "";
      const m = cc.match(/max-age=(\d+)/);
      if (store.size >= 200) store.delete(store.keys().next().value);
      store.set(keyOf(k), {
        body, status: response.status,
        headers: Object.fromEntries(response.headers),
        expires: m ? Date.now() + Number(m[1]) * 1000 : 0,
      });
    },
    async delete(k) { return store.delete(keyOf(k)); },
  };
}
export function installCaches() {
  if (globalThis.caches && globalThis.caches.default) return;
  const def = makeCache();
  const named = new Map();
  globalThis.caches = {
    default: def,
    async open(name) {
      if (!named.has(name)) named.set(name, makeCache());
      return named.get(name);
    },
  };
}
```

- [ ] **Step 4: Implement `server/app.js`**

```js
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { resolveRoute } from "./router.js";
import { installCaches } from "./cache.js";

const METHOD_EXPORT = { GET: "onRequestGet", HEAD: "onRequestGet", POST: "onRequestPost", PUT: "onRequestPut", DELETE: "onRequestDelete", PATCH: "onRequestPatch" };

export function createApp(env, routes, functionsDir) {
  installCaches();
  const moduleCache = new Map();
  async function loadModule(rel) {
    if (!moduleCache.has(rel))
      moduleCache.set(rel, import(pathToFileURL(join(functionsDir, rel)).href));
    return moduleCache.get(rel);
  }
  return {
    async handle(request) {
      const background = [];
      const url = new URL(request.url);
      let response;
      try {
        const hit = resolveRoute(routes, url.pathname);
        let handler = null, params = {};
        if (hit) {
          const mod = await loadModule(hit.modulePath);
          handler = mod[METHOD_EXPORT[request.method]] || mod.onRequest || null;
          params = hit.params;
        }
        if (!handler) {
          response = await env.ASSETS.fetch(request);
        } else {
          const context = {
            request, env, params,
            functionPath: hit.modulePath,
            waitUntil: (p) => background.push(Promise.resolve(p).catch((e) => console.error("waitUntil:", e))),
            next: () => env.ASSETS.fetch(request),
            data: {},
          };
          response = await handler(context);
        }
      } catch (e) {
        console.error(request.method, url.pathname, e);
        response = new Response("Internal Server Error", { status: 500 });
      }
      return { response, background };
    },
  };
}
```

- [ ] **Step 5: Implement `server/index.js`**

```js
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import pg from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import { buildRouteTable } from "./router.js";
import { createKv } from "./kv.js";
import { createBucket } from "./r2.js";
import { createAssets } from "./assets.js";
import { createApp } from "./app.js";

const ROOT = new URL("..", import.meta.url).pathname;
const FUNCTIONS_DIR = join(ROOT, "functions");
const DIST_DIR = process.env.DIST_DIR || join(ROOT, "dist");
const PORT = Number(process.env.PORT || 8788);

function listFunctionFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFunctionFiles(full, base));
    else if (name.endsWith(".js")) out.push(relative(base, full));
  }
  return out;
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ssl: process.env.PGSSLROOTCERT
    ? { ca: readFileSync(process.env.PGSSLROOTCERT, "utf8") }
    : { rejectUnauthorized: false },
});
const s3 = new S3Client({
  endpoint: process.env.SPACES_ENDPOINT || "https://nyc3.digitaloceanspaces.com",
  region: "us-east-1",
  credentials: { accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET },
});

const env = {
  OVERRIDES: createKv(pool),
  OVERRIDE_IMAGES: createBucket(s3, process.env.SPACES_BUCKET || "otratickets-media"),
  ASSETS: createAssets(DIST_DIR, join(ROOT, "_headers")),
  OTRA_API_URL: process.env.OTRA_API_URL || undefined,
};
const app = createApp(env, buildRouteTable(listFunctionFiles(FUNCTIONS_DIR)), FUNCTIONS_DIR);

// Ensure schema exists before serving.
await pool.query(readFileSync(join(ROOT, "server", "schema.sql"), "utf8"));

http.createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const url = `https://${req.headers.host || "otratickets.com"}${req.url}`;
    const hasBody = !(req.method === "GET" || req.method === "HEAD");
    const request = new Request(url, {
      method: req.method, headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    });
    const { response, background } = await app.handle(request);
    const out = {};
    for (const [k, v] of response.headers) if (k !== "set-cookie") out[k] = v;
    res.writeHead(response.status, { ...out, ...(response.headers.getSetCookie().length ? { "set-cookie": response.headers.getSetCookie() } : {}) });
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
    await Promise.allSettled(background);
  } catch (e) {
    console.error("adapter:", e);
    if (!res.headersSent) res.writeHead(500);
    res.end("Internal Server Error");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`otratickets server on 127.0.0.1:${PORT}`));
```

- [ ] **Step 6: Run the full suite** — `node --test server/test/` expecting all green.

- [ ] **Step 7: Local smoke against real functions with stub env**

```bash
node -e '
import("./server/app.js").then(async ({ createApp }) => {
  const { buildRouteTable } = await import("./server/router.js");
  const { createAssets } = await import("./server/assets.js");
  const fs = await import("node:fs"); const path = await import("node:path");
  const list = (d, b=d) => fs.readdirSync(d).flatMap(n => {
    const f = path.join(d, n);
    return fs.statSync(f).isDirectory() ? list(f, b) : n.endsWith(".js") ? [path.relative(b, f)] : [];
  });
  const env = {
    OVERRIDES: { get: async () => null, getWithMetadata: async () => ({ value: null, metadata: null }), put: async () => {}, list: async () => ({ keys: [], list_complete: true }), delete: async () => {} },
    OVERRIDE_IMAGES: { get: async () => null, put: async () => {} },
    ASSETS: createAssets("dist", "_headers"),
  };
  const app = createApp(env, buildRouteTable(list("functions")), "functions");
  for (const p of ["/", "/robots.txt", "/sitemap.xml", "/api/homepage-events"]) {
    const { response } = await app.handle(new Request("https://otratickets.com" + p));
    console.log(p, response.status);
  }
});'
```

Expect `/` 200, `/robots.txt` 200, `/sitemap.xml` 200 (may be slow: it calls the live Django API), `/api/homepage-events` 200 or 5xx-free JSON (empty KV means it rebuilds from the live API; any 500 here must be investigated, not shrugged off).

- [ ] **Step 8: Commit** — `git add server/ && git commit -m "feat(server): HTTP adapter, dispatcher, cache polyfill, entrypoint"`

---

### Task 6: Droplet configuration (Caddy, systemd, secrets, TLS)

**Files:**
- Create: `deploy/Caddyfile`, `deploy/otratickets.service`, `deploy/setup-droplet.sh`

**Interfaces:**
- Consumes: droplet IP + secrets from Task 1 (scratchpad `do-secrets.env`), server code from Tasks 2-5.
- Produces: droplet serving otratickets.com content on 443 for direct `curl --resolve` tests; `deploy` user accepting the CI deploy key; systemd unit named `otratickets`.

- [ ] **Step 1: Write `deploy/Caddyfile`**

```
{
  auto_https off
}

:80 {
  redir https://{host}{uri} permanent
}

https://otratickets.com:443, https://www.otratickets.com:443 {
  tls /etc/caddy/origin-cert/cert.pem /etc/caddy/origin-cert/key.pem
  encode zstd gzip
  reverse_proxy 127.0.0.1:8788
  log {
    output file /var/log/caddy/access.log {
      roll_size 50MiB
      roll_keep 5
    }
    format json
  }
}
```

- [ ] **Step 2: Write `deploy/otratickets.service`**

```ini
[Unit]
Description=otratickets.com Node server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/otratickets
EnvironmentFile=/etc/otratickets/env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/srv/otratickets

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Write `deploy/setup-droplet.sh`** (idempotent; run as root on the droplet)

```bash
#!/usr/bin/env bash
set -euo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 DEBIAN_FRONTEND=noninteractive

# Node 22 (NodeSource) and Caddy (official repo), unattended upgrades, rsync
apt-get update -y
apt-get install -y ca-certificates curl gnupg unattended-upgrades rsync
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# deploy user + directories
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
mkdir -p /srv/otratickets /etc/otratickets /etc/caddy/origin-cert /var/log/caddy
chown -R deploy:deploy /srv/otratickets
chown caddy:caddy /var/log/caddy || true

# deploy user may restart only this service
cat > /etc/sudoers.d/otratickets-deploy <<'SUDO'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart otratickets, /usr/bin/systemctl status otratickets
SUDO
chmod 440 /etc/sudoers.d/otratickets-deploy

echo "setup-droplet.sh done. Next: /etc/otratickets/env, origin cert, authorized_keys for deploy, install unit + Caddyfile."
```

- [ ] **Step 4: Run setup on the droplet**

```bash
DROPLET_IP=$(doctl compute droplet get otratickets-web-1 --format PublicIPv4 --no-header)
scp -o StrictHostKeyChecking=accept-new deploy/setup-droplet.sh root@"$DROPLET_IP":/root/
ssh root@"$DROPLET_IP" 'bash /root/setup-droplet.sh'
```

- [ ] **Step 5: Install secrets env file on the droplet**

Build locally from the scratchpad values (`do-secrets.env` from Task 1; PG CA from Task 1 Step 7), then push:

```bash
cat > "$SCRATCHPAD/otratickets.env" <<EOF
PORT=8788
DATABASE_URL=postgresql://otratickets:${PG_PASSWORD}@${PG_PRIVATE_HOST}:25060/otratickets?sslmode=require
PGSSLROOTCERT=/etc/otratickets/pg-ca.crt
SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com
SPACES_BUCKET=otratickets-media
SPACES_KEY=${SPACES_KEY}
SPACES_SECRET=${SPACES_SECRET}
EOF
scp "$SCRATCHPAD/otratickets.env" root@"$DROPLET_IP":/etc/otratickets/env
scp "$SCRATCHPAD/pg-ca.crt" root@"$DROPLET_IP":/etc/otratickets/pg-ca.crt
ssh root@"$DROPLET_IP" 'chmod 600 /etc/otratickets/env; chown root:deploy /etc/otratickets/env; chmod 640 /etc/otratickets/env /etc/otratickets/pg-ca.crt; chown root:deploy /etc/otratickets/pg-ca.crt'
```

Port note: DO managed Postgres listens on 25060; confirm with the URI from Task 1 Step 3 and use whatever port it shows. Do NOT set OTRA_API_URL unless `functions/admin/api/_auth.js`'s built-in default is wrong; read that file's `OTRA_API` constant and only add the env var if it must differ.

- [ ] **Step 6: TLS origin certificate**

Check the zone's SSL mode first:

```bash
ZONE_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=otratickets.com" | python -c "import json,sys;print(json.load(sys.stdin)['result'][0]['id'])")
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings/ssl" | python -m json.tool
```

- If mode is `full` (not strict): generate a self-signed cert on the droplet; Cloudflare accepts it:

```bash
ssh root@"$DROPLET_IP" 'openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=otratickets.com" -addext "subjectAltName=DNS:otratickets.com,DNS:www.otratickets.com" \
  -keyout /etc/caddy/origin-cert/key.pem -out /etc/caddy/origin-cert/cert.pem && \
  chown -R caddy:caddy /etc/caddy/origin-cert'
```

- If mode is `strict`: try creating a Cloudflare Origin CA certificate via `POST https://api.cloudflare.com/client/v4/certificates` with the API token (body: `{"hostnames":["otratickets.com","www.otratickets.com"],"request_type":"origin-rsa","requested_validity":5475,"csr":"<csr-pem>"}`, CSR generated on the droplet with openssl). If the API rejects the token for Origin CA (it may require a separate Origin CA Key), fall back: set the zone SSL mode to `full` via the API (`PATCH .../settings/ssl {"value":"full"}`), use the self-signed cert above, and record in the runbook that upgrading back to `strict` requires an Origin CA cert created in the dashboard. Traffic remains encrypted either way; this is a validation-strength tradeoff, not plaintext.

- [ ] **Step 7: First manual deploy of code + configs**

```bash
rsync -az --delete --exclude node_modules dist functions server package.json deploy root@"$DROPLET_IP":/srv/otratickets/
ssh root@"$DROPLET_IP" 'chown -R deploy:deploy /srv/otratickets && cd /srv/otratickets && sudo -u deploy npm --prefix server ci --omit=dev && cp deploy/otratickets.service /etc/systemd/system/ && cp deploy/Caddyfile /etc/caddy/Caddyfile && systemctl daemon-reload && systemctl enable --now otratickets && systemctl reload caddy || systemctl restart caddy'
ssh root@"$DROPLET_IP" 'systemctl is-active otratickets caddy && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8788/robots.txt'
```

Expected: both `active`, robots 200. If the Node service crash-loops, `journalctl -u otratickets -n 50` and fix before proceeding (most likely DATABASE_URL or CA path).

- [ ] **Step 8: Deploy SSH key for CI**

```bash
ssh-keygen -t ed25519 -N "" -C "otratickets-deploy" -f "$SCRATCHPAD/otratickets_deploy"
ssh root@"$DROPLET_IP" 'sudo -u deploy mkdir -p /home/deploy/.ssh && sudo -u deploy touch /home/deploy/.ssh/authorized_keys && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys'
cat "$SCRATCHPAD/otratickets_deploy.pub" | ssh root@"$DROPLET_IP" 'cat >> /home/deploy/.ssh/authorized_keys && chown deploy:deploy /home/deploy/.ssh/authorized_keys'
ssh -i "$SCRATCHPAD/otratickets_deploy" deploy@"$DROPLET_IP" 'echo deploy-login-ok'
```

- [ ] **Step 9: Direct verification through Caddy**

```bash
curl -sk --resolve otratickets.com:443:"$DROPLET_IP" https://otratickets.com/ -o /dev/null -w "home:%{http_code}\n"
curl -sk --resolve otratickets.com:443:"$DROPLET_IP" https://otratickets.com/api/homepage-events -D - -o /dev/null | grep -i "x-feed-source\|HTTP/"
```

Expected: home 200; feed 200 with an `x-feed-source` header (`origin` is fine at this point since the kv table is still empty).

- [ ] **Step 10: Commit** — `git add deploy/ && git commit -m "infra: droplet setup script, Caddyfile, systemd unit"`

---

### Task 7: Cloudflare data migration scripts (KV -> Postgres, R2 -> Spaces)

**Files:**
- Create: `scripts/migrate/cf-api.mjs`, `scripts/migrate/export-kv.mjs`, `scripts/migrate/export-r2.mjs`, `scripts/migrate/README.md`

**Interfaces:**
- Consumes: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (local env), `DATABASE_URL`/`PGSSLROOTCERT` and Spaces credentials (from the scratchpad env file; scripts read process.env).
- Produces: idempotent scripts; run twice each with identical results. `cf-api.mjs` exports `discoverBindings()` -> `{ kvNamespaceId, r2BucketName, pagesProjectName }`.

Note on DB connectivity from the laptop: the cluster's PUBLIC hostname works from outside the VPC only if the trusted-source check passes. If Task 1 Step 5 found rules non-empty (locked-down cluster), the laptop is not a trusted source; in that case run these scripts ON the droplet (rsync `scripts/migrate` there; env is already in `/etc/otratickets/env`, add the two Cloudflare variables for the run only, then remove them). Decide at run time; both paths use the same scripts. When run on the droplet use the private DATABASE_URL as-is.

- [ ] **Step 1: `scripts/migrate/cf-api.mjs`**

```js
// Minimal Cloudflare REST client for the migration. Read-only.
const BASE = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!TOKEN || !ACCOUNT) throw new Error("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID required");

export async function cf(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`CF ${path}: ${res.status} ${await res.text()}`);
  return res;
}
export async function cfJson(path) {
  const data = await (await cf(path)).json();
  if (!data.success) throw new Error(`CF ${path}: ${JSON.stringify(data.errors)}`);
  return data.result;
}
export async function discoverBindings() {
  const projects = await cfJson(`/accounts/${ACCOUNT}/pages/projects`);
  const project = projects.find((p) =>
    (p.domains || []).some((d) => d.includes("otratickets.com"))) || projects[0];
  if (!project) throw new Error("no Pages project found");
  const conf = (project.deployment_configs || {}).production || {};
  const kv = conf.kv_namespaces && conf.kv_namespaces.OVERRIDES;
  const r2 = conf.r2_buckets && conf.r2_buckets.OVERRIDE_IMAGES;
  if (!kv || !r2) throw new Error(`bindings missing on project ${project.name}: ${JSON.stringify(conf)}`);
  return { pagesProjectName: project.name, kvNamespaceId: kv.namespace_id, r2BucketName: r2.name, account: ACCOUNT };
}
```

- [ ] **Step 2: `scripts/migrate/export-kv.mjs`**

```js
import pg from "pg";
import { readFileSync } from "node:fs";
import { cf, cfJson, discoverBindings } from "./cf-api.mjs";

const { kvNamespaceId, account } = await discoverBindings();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, max: 4,
  ssl: process.env.PGSSLROOTCERT ? { ca: readFileSync(process.env.PGSSLROOTCERT, "utf8") } : { rejectUnauthorized: false },
});
await pool.query(readFileSync(new URL("../../server/schema.sql", import.meta.url), "utf8"));

let cursor = "", total = 0;
do {
  const url = `/accounts/${account}/storage/kv/namespaces/${kvNamespaceId}/keys?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
  const res = await (await cf(url)).json();
  if (!res.success) throw new Error(JSON.stringify(res.errors));
  for (const k of res.result) {
    const vres = await cf(`/accounts/${account}/storage/kv/namespaces/${kvNamespaceId}/values/${encodeURIComponent(k.name)}`);
    const buf = Buffer.from(await vres.arrayBuffer());
    await pool.query(
      `INSERT INTO kv (key, value, metadata, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, metadata = $3, updated_at = now()`,
      [k.name, buf, k.metadata ? JSON.stringify(k.metadata) : null]);
    total++;
    if (total % 50 === 0) console.log(`  ${total} keys...`);
  }
  cursor = res.result_info && res.result_info.cursor || "";
} while (cursor);
console.log(`export-kv done: ${total} keys`);
const { rows } = await pool.query("SELECT count(*) FROM kv");
console.log(`kv table now holds ${rows[0].count} rows`);
await pool.end();
```

- [ ] **Step 3: `scripts/migrate/export-r2.mjs`**

```js
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { cf, discoverBindings } from "./cf-api.mjs";

const { r2BucketName, account } = await discoverBindings();
const s3 = new S3Client({
  endpoint: process.env.SPACES_ENDPOINT || "https://nyc3.digitaloceanspaces.com",
  region: "us-east-1",
  credentials: { accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET },
});
const BUCKET = process.env.SPACES_BUCKET || "otratickets-media";

let cursor = "", total = 0, skipped = 0;
do {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const page = await (await cf(`/accounts/${account}/r2/buckets/${r2BucketName}/objects${q}`)).json();
  if (!page.success) throw new Error(JSON.stringify(page.errors));
  for (const obj of page.result) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: obj.key }));
      if (head.ContentLength === obj.size) { skipped++; continue; } // already copied
    } catch { /* not present: copy it */ }
    const body = await cf(`/accounts/${account}/r2/buckets/${r2BucketName}/objects/${obj.key.split("/").map(encodeURIComponent).join("/")}`);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: obj.key,
      Body: Buffer.from(await body.arrayBuffer()),
      ContentType: obj.http_metadata && obj.http_metadata.contentType || body.headers.get("content-type") || "application/octet-stream",
    }));
    total++;
    if (total % 25 === 0) console.log(`  ${total} objects...`);
  }
  cursor = page.result_info && page.result_info.cursor || "";
} while (cursor);
console.log(`export-r2 done: ${total} copied, ${skipped} already present`);
```

First run: probe with a SINGLE object before the loop (add a temporary early `process.exit(0)` after one successful copy, or just observe the first iteration). If the R2 object-download endpoint rejects the token, STOP and report: the fallback is R2 S3 credentials created in the Cloudflare dashboard by Brian (blocked-on-user moment; everything else proceeds).

- [ ] **Step 4: `scripts/migrate/README.md`** documenting: required env vars, running from laptop vs droplet (see connectivity note above), idempotency (safe to re-run; the final pre-cutover re-run is mandatory), and that these scripts never write to Cloudflare.

- [ ] **Step 5: Run both, verify counts**

Run `node scripts/migrate/export-kv.mjs` then `node scripts/migrate/export-r2.mjs` (location per the connectivity note). Verify: kv row count > 0 and equal to the CF keys listed; spot-check three keys (one `override:`, one `site-event:`, the `SNAPSHOT_KEY` from `functions/_lib/homepage-feed.js`) by comparing CF value bytes to PG value bytes. Spot-check one media object end to end: `curl -sk --resolve otratickets.com:443:$DROPLET_IP https://otratickets.com/override-images/<known-key>` returns the image with the right content type.

- [ ] **Step 6: Commit** — `git add scripts/migrate && git commit -m "feat(migrate): Cloudflare KV and R2 export scripts (idempotent)"`

---

### Task 8: GitHub Actions deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: deploy key from Task 6 Step 8 (`$SCRATCHPAD/otratickets_deploy`), droplet IP.
- Produces: push-to-main deploys; `workflow_dispatch` manual deploys.

- [ ] **Step 1: Set repo secrets**

```bash
DROPLET_IP=$(doctl compute droplet get otratickets-web-1 --format PublicIPv4 --no-header)
gh secret set DEPLOY_HOST --body "$DROPLET_IP"
gh secret set DEPLOY_SSH_KEY < "$SCRATCHPAD/otratickets_deploy"
```

- [ ] **Step 2: Write `.github/workflows/deploy.yml`**

```yaml
name: Deploy to DigitalOcean
on:
  push:
    branches: [main]
  workflow_dispatch: {}
concurrency:
  group: deploy-production
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run server tests
        run: |
          cd server && npm ci && cd ..
          node --test server/test/
      - name: Set up SSH
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.DEPLOY_SSH_KEY }}" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          ssh-keyscan -H "${{ secrets.DEPLOY_HOST }}" >> ~/.ssh/known_hosts
      - name: Rsync code
        run: |
          rsync -az --delete \
            -e "ssh -i ~/.ssh/deploy_key" \
            dist functions server package.json _headers \
            deploy@${{ secrets.DEPLOY_HOST }}:/srv/otratickets/
      - name: Install deps and restart
        run: |
          ssh -i ~/.ssh/deploy_key deploy@${{ secrets.DEPLOY_HOST }} \
            'cd /srv/otratickets && npm --prefix server ci --omit=dev && sudo systemctl restart otratickets'
      - name: Health check
        run: |
          for i in $(seq 1 10); do
            code=$(ssh -i ~/.ssh/deploy_key deploy@${{ secrets.DEPLOY_HOST }} \
              'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8788/api/homepage-events')
            [ "$code" = "200" ] && echo "healthy" && exit 0
            echo "attempt $i: $code"; sleep 3
          done
          echo "health check failed" && exit 1
```

Note `--delete` scope: it only touches the four rsynced paths, so `/srv/otratickets/deploy` and `server/node_modules` (excluded implicitly because rsync sends the `server` dir fresh... it does NOT: `--delete` on `server` would remove `node_modules`). Fix: add `--exclude node_modules` to the rsync flags exactly as written below; the workflow above must include it:

```
rsync -az --delete --exclude node_modules ...
```

Use that corrected line in the actual file.

- [ ] **Step 3: Verify the workflow runs** — after this branch merges to main the push event fires; for now trigger manually once the branch is pushed: `gh workflow run deploy.yml --ref infra/do-droplet-migration` requires on.push of that branch; instead validate YAML locally (`python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/deploy.yml'))"`) and rely on the PR merge to exercise it. Record in the task report that the first live run happens at merge.

- [ ] **Step 4: Commit** — `git add .github/workflows/deploy.yml && git commit -m "ci: deploy to the droplet on push to main"`

---

### Task 9: Runbook for a first-time Caddy/systemd operator

**Files:**
- Create: `docs/deploy/README.md`

**Interfaces:**
- Consumes: everything above (real names, real paths).

- [ ] **Step 1: Write the runbook.** Sections, in this order, all concrete to THIS setup (no generic tutorial content): 

1. "The moving parts" (request path diagram: Cloudflare -> Caddy -> Node -> Postgres/Spaces/Django API; one paragraph per part explaining what it does and why it exists, written for someone who has never used Caddy or systemd).
2. "Where everything lives" (a table: `/srv/otratickets` code, `/etc/otratickets/env` secrets, `/etc/caddy/Caddyfile`, `/etc/caddy/origin-cert/`, `/etc/systemd/system/otratickets.service`, `/var/log/caddy/access.log`, journald).
3. "Deploys" (what the GitHub Action does step by step; how to watch it; how to deploy manually with the rsync+restart commands; how to roll back a bad deploy: `git revert` + merge, or manual rsync of the previous commit).
4. "Reading logs" (`journalctl -u otratickets -f`, `-n 200`, `--since "1 hour ago"`; Caddy JSON access log and a jq one-liner for status-code counts).
5. "Restarting and status" (`systemctl status/restart otratickets`, `systemctl reload caddy`, what Restart=always means).
6. "DNS rollback to Cloudflare Pages" (exact records to flip back, with the record JSON snapshot location from Task 10; the caveat that post-cutover admin edits will not be visible on Pages).
7. "Resizing the droplet" (doctl resize command, expected downtime).
8. "Rotating secrets" (Spaces key: create new, update env, delete old; PG password: `doctl databases user reset`; deploy key: regenerate + gh secret set).
9. "TLS" (which SSL mode the zone uses, where the cert came from, how to upgrade to strict with an Origin CA cert if we used the fallback).
10. "Costs and monthly review" (what this stack costs; the Pages project retirement checklist once stable).

- [ ] **Step 2: Verify every command in the runbook is real** (run the read-only ones; eyeball the mutating ones against the actual files created in Tasks 6-8).

- [ ] **Step 3: Commit** — `git add docs/deploy/README.md && git commit -m "docs: droplet operations runbook"`

---

### Task 10: Pre-cutover verification, final sync, DNS cutover

This task is executed by the main session (not a subagent): it changes live traffic.

**Files:**
- Create: `deploy/cutover-log.md` (timestamps, record snapshots, verification results)

- [ ] **Step 1: Full verification against the droplet, before DNS**

```bash
DROPLET_IP=$(doctl compute droplet get otratickets-web-1 --format PublicIPv4 --no-header)
for path in / /robots.txt /sitemap.xml /llms.txt; do
  curl -sk --resolve otratickets.com:443:"$DROPLET_IP" "https://otratickets.com$path" -o /dev/null -w "$path %{http_code} %{time_total}s\n"; done
curl -sk --resolve otratickets.com:443:"$DROPLET_IP" https://otratickets.com/api/homepage-events -D - -o /dev/null | grep -i "x-feed-source\|HTTP/"
```

Also: pick one live event slug from the current homepage, fetch it via `--resolve`, and grep the HTML for its injected title/meta (proves `[slug].js` + KV overrides). Fetch one `/override-images/...` URL referenced by that page (proves Spaces path). Expected all 200; feed shows `x-feed-source: kv-fresh` or `kv-stale` (snapshot now lives in Postgres). Run the repo's checks that accept a base URL (read `scripts/check-feed-fast-path.mjs` and `scripts/check-seo-aeo.mjs` for how they target the site; run them with the droplet as target if supported, otherwise record the curl equivalents in the cutover log).

- [ ] **Step 2: Admin flow verification.** Report to Brian for a manual admin login + a test image upload through the admin UI against the droplet (hosts-file entry or defer to immediately post-cutover with rollback ready). If deferred, note it in the cutover log.

- [ ] **Step 3: Final data re-sync** — re-run `export-kv.mjs` and `export-r2.mjs` (idempotent) to catch admin writes since the first sync.

- [ ] **Step 4: Snapshot current DNS, then flip**

```bash
ZONE_ID=... # from Task 6 Step 6
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?per_page=100" \
  | python -m json.tool > "$SCRATCHPAD/dns-before-cutover.json"
```

Identify the records serving otratickets.com and www (CNAMEs to `<project>.pages.dev`). For each, `PUT /zones/$ZONE_ID/dns_records/<id>` with `{"type":"A","name":"otratickets.com","content":"<DROPLET_IP>","proxied":true,"ttl":1}` (www: `{"type":"CNAME","name":"www","content":"otratickets.com","proxied":true,"ttl":1}`). Copy `dns-before-cutover.json` into `deploy/cutover-log.md` (it contains no secrets) with the exact rollback `PUT` bodies.

- [ ] **Step 5: Post-cutover watch (30+ minutes)**

```bash
curl -s https://otratickets.com/ -o /dev/null -w "home %{http_code} %{time_total}s\n"
curl -s https://otratickets.com/api/homepage-events -D - -o /dev/null | grep -i x-feed-source
ssh root@"$DROPLET_IP" 'journalctl -u otratickets --since "-10 min" -p err --no-pager | tail -20'
ssh root@"$DROPLET_IP" "tail -200 /var/log/caddy/access.log | python -c \"import json,sys,collections; c=collections.Counter(json.loads(l)['status'] for l in sys.stdin if l.strip()); print(dict(c))\""
```

Confirm: no 5xx accumulation, feed header healthy, an event page renders, admin login + upload works (Brian or Marilia). Record results in the cutover log. Rollback trigger: sustained 5xx on any core path or a broken admin flow that resists a quick fix; execute the rollback PUTs from the cutover log.

- [ ] **Step 6: Commit** — `git add deploy/cutover-log.md && git commit -m "infra: cutover log and DNS rollback snapshot"`

---

### Task 11: PR, Notion close-out, memory

- [ ] **Step 1: Push branch and open the PR** (Brian confirmed moving forward; Otra-Tickets is not the push-restricted repo)

```bash
git push -u origin infra/do-droplet-migration
gh pr create --title "infra: serve otratickets.com from a DigitalOcean droplet" --body "..."
```

PR body: summary of architecture, link to spec and runbook, cutover status, rollback instructions, note that merging triggers the first live GitHub Actions deploy. End with the standard attribution footer.

- [ ] **Step 2: Update the Notion task** (page `3c38bd98-5cfb-8170-b789-f77c9196b6e4`): status stays In progress until Brian merges and the deploy Action goes green; add a comment-style block at the top of the page body with cutover timestamp, droplet IP, and PR link.

- [ ] **Step 3: Update session memory** (`otra-guide-digitalocean-layout.md`): droplet exists now, record IP, db, bucket, and that cutover happened (or its current state).

---

## Self-Review Notes

- Spec coverage: provisioning (T1), server runtime (T2-T5), droplet config + TLS (T6), migration (T7), CI (T8), runbook (T9), cutover + rollback (T10), delivery (T11). Monitoring alerts from the spec's operations section are covered by droplet `--enable-monitoring` (T1) plus the runbook's log guidance; a DO alert policy is a post-cutover nicety, listed in the runbook's monthly review section.
- The `_headers` parser and R2 range handling both instruct the implementer to read the corresponding repo files first and match them exactly; the plan's code is the baseline, the repo files are the contract.
- Type consistency: `createKv(pool)`, `createBucket(s3, name)`, `createAssets(dir, headersFile)`, `createApp(env, routes, functionsDir)`, `buildRouteTable(fileList)`, `resolveRoute(routes, pathname)` are used with those exact signatures in every task that consumes them.
