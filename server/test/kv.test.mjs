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
        const [pattern, after, limit] = params;
        // Unescape the pattern: strip trailing '%', then unescape '\' sequences
        const unescaped = pattern.slice(0, -1).replace(/\\(.)/g, "$1");
        const keys = [...store.keys()].filter(k => k.startsWith(unescaped) && k > after).sort().slice(0, limit);
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
test("list treats prefix as literal, escaping LIKE wildcards", async () => {
  const kv = createKv(stubPool());
  await kv.put("a_b:1", "v1");
  await kv.put("axb:1", "v2");
  const result = await kv.list({ prefix: "a_b:" });
  assert.deepEqual(result.keys.map(k => k.name), ["a_b:1"]);
});
