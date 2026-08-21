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
