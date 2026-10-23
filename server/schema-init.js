import { readFileSync } from "node:fs";

export async function initializeSchema(pool, setting) {
  if (setting === "false") return;
  if (setting !== undefined && setting !== "true") {
    throw new Error("RUN_SCHEMA_INIT must be true or false when set");
  }
  await pool.query(readFileSync(new URL("schema.sql", import.meta.url), "utf8"));
}
