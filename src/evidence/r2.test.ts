import assert from "node:assert/strict";
import test from "node:test";
import { signV4 } from "./r2.ts";
import { startFakeR2 } from "./r2-fake.ts";
import { headObject, listAllObjects, publicUrl, putObject } from "./r2.ts";

const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("signs requests like the AWS Signature V4 examples for S3", () => {
  const object = signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { range: "bytes=0-9", "x-amz-content-sha256": emptyHash, "x-amz-date": "20130524T000000Z" }, ...credentials });
  assert.match(object, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  const list = signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"), headers: { "x-amz-content-sha256": emptyHash, "x-amz-date": "20130524T000000Z" }, ...credentials });
  assert.match(list, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
});

test("keeps stored keys exact in requests, listings and public URLs", async (t) => {
  const r2 = await startFakeR2();
  t.after(() => r2.close());
  const key = "cases/case%201/evidence/a & b's (1).md";
  await putObject(key, "x", { contentType: "text/markdown", overwrite: true });
  assert.ok(r2.objects.has(key));
  assert.deepEqual((await listAllObjects("cases/case%201/")).map((object) => object.key), [key]);
  assert.equal((await headObject(key))?.size, 1);
  assert.equal(publicUrl(key), "https://public.test/cases/case%25201/evidence/a%20%26%20b%27s%20%281%29.md");
});
