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

// --- Extensions driven by functions/override-media/[[path]].js and
// functions/override-images/[[path]].js, which are the real R2Bucket
// consumers. Both call `object.writeHttpMetadata(headers)` and then
// `headers.set("etag", object.httpEtag)` separately (real R2's
// writeHttpMetadata does not set etag). override-images also reads
// `object.range` and `object.size` to build Content-Range/Content-Length
// on a 206 response, and expects `object.size` to be the object's FULL
// size even when a byte range was requested (S3's ContentLength on a
// ranged GetObject is only the partial length).

test("get exposes both etag (unquoted) and httpEtag (quoted) like R2Object", async () => {
  const b = createBucket(stubS3(), "m");
  const obj = await b.get("hit.webp");
  assert.equal(obj.httpEtag, '"abc"');
  assert.equal(obj.etag, "abc");
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  assert.equal(h.get("etag"), '"abc"');
});

test("get echoes the requested range back as object.range", async () => {
  const b = createBucket(stubS3(), "m");
  const withOffsetLength = await b.get("hit", { range: { offset: 10, length: 5 } });
  assert.deepEqual(withOffsetLength.range, { offset: 10, length: 5 });
  const withOffsetOnly = await b.get("hit", { range: { offset: 10 } });
  assert.deepEqual(withOffsetOnly.range, { offset: 10 });
  const withSuffix = await b.get("hit", { range: { suffix: 100 } });
  assert.deepEqual(withSuffix.range, { suffix: 100 });
  const noRange = await b.get("hit");
  assert.equal(noRange.range, undefined);
});

function stubS3WithContentRange() {
  return {
    async send(cmd) {
      if (cmd.constructor.name !== "GetObjectCommand") throw new Error("unexpected");
      if (cmd.input.Range) {
        // S3 semantics: ContentLength is the PARTIAL length returned;
        // ContentRange carries "bytes start-end/total".
        return {
          Body: { transformToWebStream: () => "stream" },
          ContentType: "video/mp4", ContentLength: 5, ETag: '"v"',
          ContentRange: "bytes 10-14/500",
        };
      }
      return {
        Body: { transformToWebStream: () => "stream" },
        ContentType: "video/mp4", ContentLength: 500, ETag: '"v"',
      };
    },
  };
}

test("size is the object's total size, not the partial range length", async () => {
  const b = createBucket(stubS3WithContentRange(), "m");
  const ranged = await b.get("video.mp4", { range: { offset: 10, length: 5 } });
  assert.equal(ranged.size, 500);
  const full = await b.get("video.mp4");
  assert.equal(full.size, 500);
});

test("matches the Content-Range math functions/override-images/[[path]].js performs", async () => {
  // Mirrors: offset = object.range.offset ?? object.size - object.range.suffix;
  //          length = object.range.length ?? object.size - offset;
  const b = createBucket(stubS3WithContentRange(), "m");
  const object = await b.get("video.mp4", { range: { offset: 10, length: 5 } });
  const offset = object.range.offset !== undefined ? object.range.offset : object.size - object.range.suffix;
  const length = object.range.length !== undefined ? object.range.length : object.size - offset;
  assert.equal(`bytes ${offset}-${offset + length - 1}/${object.size}`, "bytes 10-14/500");
});
