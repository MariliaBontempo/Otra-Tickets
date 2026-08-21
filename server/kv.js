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
