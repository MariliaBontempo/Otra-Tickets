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
