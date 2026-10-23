import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeSchema } from "../schema-init.js";

test("explicit false skips all schema queries", async () => {
  const pool = { query() { assert.fail("DDL must not run"); } };
  await initializeSchema(pool, "false");
});

test("default and true preserve schema initialization", async () => {
  for (const value of [undefined, "true"]) {
    const queries = [];
    await initializeSchema({ async query(sql) { queries.push(sql); } }, value);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /CREATE TABLE IF NOT EXISTS kv/);
  }
});

test("invalid values fail before any schema query", async () => {
  for (const value of ["FALSE", "0", "", "typo"]) {
    await assert.rejects(initializeSchema({ query() { assert.fail("DDL must not run"); } }, value), /RUN_SCHEMA_INIT/);
  }
});
