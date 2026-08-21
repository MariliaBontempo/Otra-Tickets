// Cloudflare R2Bucket shim over an S3-compatible client (DigitalOcean Spaces).
// The consumers are functions/override-media/[[path]].js and
// functions/override-images/[[path]].js, which expect real R2Object shape:
// both .etag (unquoted) AND .httpEtag (quoted, set separately from
// writeHttpMetadata), plus .range/.size for building 206 Content-Range
// responses on ranged video/image requests.
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

function toS3Range(range) {
  if (!range) return undefined;
  if (range.suffix != null) return `bytes=-${range.suffix}`;
  const start = range.offset || 0;
  return range.length != null ? `bytes=${start}-${start + range.length - 1}` : `bytes=${start}-`;
}

// S3's ContentLength on a ranged GetObject is only the partial byte count;
// the object's full size lives in ContentRange ("bytes start-end/total").
// R2Object.size is always the full object size, ranged or not, so callers
// (override-images) can derive offset/length from a suffix range using it.
function totalSize(out) {
  if (out.ContentRange) {
    const match = /\/(\d+)$/.exec(out.ContentRange);
    if (match) return Number(match[1]);
  }
  return out.ContentLength;
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
      const etagRaw = out.ETag || "";
      return {
        key,
        size: totalSize(out),
        etag: etagRaw.replace(/^"|"$/g, ""),
        httpEtag: etagRaw,
        range: opts.range,
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
