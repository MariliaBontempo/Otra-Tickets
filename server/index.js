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
// node-postgres emits "error" on the pool when an idle client's connection
// dies (routine during a managed-Postgres failover); an unhandled emission
// crashes the process. Log and let the pool recover the connection itself.
pool.on("error", (e) => console.error("pg pool:", e));
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
