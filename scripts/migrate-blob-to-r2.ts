// Copies every object of the Vercel Blob store (BLOB_READ_WRITE_TOKEN) to the R2 bucket (R2_*).
// Dry run by default; pass --apply to copy. Objects already in R2 with the same size are skipped,
// so a run can be repeated. Nothing is deleted from Vercel Blob.
import nextEnv from "@next/env";
import { parseArgs } from "node:util";
import { head, list, type ListBlobResultBlob } from "@vercel/blob";

nextEnv.loadEnvConfig(process.cwd(), true);
const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, prefix: { type: "string", default: "" } } });

const { headObject, putObject, r2Config } = await import("../src/evidence/r2.ts");
if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required to read the Vercel Blob store.");
if (values.apply && !r2Config()) throw new Error("R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_URL are required.");

const blobs: ListBlobResultBlob[] = [];
let cursor: string | undefined;
do {
  const page = await list({ prefix: values.prefix, cursor, limit: 1000 });
  blobs.push(...page.blobs);
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

// Copies get fresh modification times, and readers take the newest hash of a file as
// current, so only the newest hash of each file is copied, after the files themselves.
const HASH = /^(.*?)\.sha256\/[a-f0-9]{64}\/(.+)$/;
const newestHash = new Map<string, ListBlobResultBlob>();
for (const blob of blobs) {
  const match = HASH.exec(blob.pathname);
  if (!match) continue;
  const file = match[1]! + match[2]!;
  const current = newestHash.get(file);
  if (!current || blob.uploadedAt >= current.uploadedAt) newestHash.set(file, blob);
}
const files = blobs.filter((blob) => !HASH.test(blob.pathname));
const hashes = [...newestHash.values()];
console.log(`${blobs.length} blobs: ${files.length} files and ${hashes.length} current hashes to copy, ${blobs.length - files.length - hashes.length} superseded hashes skipped.`);
if (!values.apply) {
  console.log("Dry run. Run again with --apply to copy them to R2.");
  process.exit(0);
}

let copied = 0, skipped = 0;
async function migrate(blob: ListBlobResultBlob): Promise<void> {
  const existing = await headObject(blob.pathname);
  if (existing && existing.size === blob.size) { skipped++; return; }
  const meta = await head(blob.url);
  const url = new URL(blob.url);
  url.searchParams.set("v", blob.etag);
  const response = await fetch(url, { cache: "no-store" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || bytes.byteLength !== blob.size) throw new Error(`Could not read ${blob.pathname}: ${response.status}, ${bytes.byteLength} of ${blob.size} bytes`);
  await putObject(blob.pathname, bytes, {
    contentType: meta.contentType,
    cacheControl: meta.cacheControl,
    contentDisposition: blob.pathname.endsWith("/case.zip") ? 'attachment; filename="case.zip"' : undefined,
    overwrite: true,
  });
  copied++;
}

async function migrateAll(items: ListBlobResultBlob[]): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < items.length) await migrate(items[next++]!);
  }));
  console.log(`${copied} copied, ${skipped} already in R2`);
}

await migrateAll(files);
await migrateAll(hashes);
process.exit(0);
