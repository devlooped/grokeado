import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { archiveEvidence, createEvidenceArchive, getOrCreateEvidenceArchive } from "./archive.ts";
import { evidenceDownloadResponse } from "./archive-download.ts";
import type { RecordedEvent } from "../domain/court.ts";
import type { EvidenceFiles } from "./validate.ts";

// Read the central directory and inflate each entry independently of the writer.
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  let position = zip.readUInt32LE(end + 16);
  assert.equal(position + directorySize, end);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(position), 0x02014b50);
    assert.equal(zip.readUInt16LE(position + 8), 0x0800);
    assert.equal(zip.readUInt16LE(position + 10), 8);
    const crc = zip.readUInt32LE(position + 16);
    const compressedSize = zip.readUInt32LE(position + 20);
    const size = zip.readUInt32LE(position + 24);
    const nameSize = zip.readUInt16LE(position + 28);
    const extraSize = zip.readUInt16LE(position + 30);
    const commentSize = zip.readUInt16LE(position + 32);
    const local = zip.readUInt32LE(position + 42);
    const name = zip.subarray(position + 46, position + 46 + nameSize).toString("utf8");
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt32LE(local + 14), crc);
    assert.equal(zip.readUInt32LE(local + 18), compressedSize);
    assert.equal(zip.readUInt32LE(local + 22), size);
    assert.equal(zip.subarray(local + 30, local + 30 + nameSize).toString("utf8"), name);
    const start = local + 30 + nameSize + zip.readUInt16LE(local + 28);
    const value = inflateRawSync(zip.subarray(start, start + compressedSize));
    assert.equal(value.length, size);
    if (name.endsWith("checksum.txt")) assert.equal(crc, 0xcbf43926);
    files.set(name, value);
    position += 46 + nameSize + extraSize + commentSize;
  }
  assert.equal(position, end);
  return files;
}

const files: EvidenceFiles = new Map<string, Uint8Array | string>([
  ["evidence/base/index.md", "# Índice"],
  ["evidence/base/timeline.md", "Cronología"],
  ["evidence/base/entities.md", "Entidades"],
  ["evidence/base/docs/submission.md", "Texto"],
  ["evidence/base/raw/original.pdf", Uint8Array.of(0, 255, 17, 128)],
  ["evidence/base/tables/original.csv", "a,b\n1,2\n"],
  ["evidence/grok/ámbito.md", "Aporte del analista"],
  ["evidence/grok/research/run/step-000.json", '{"content":"contenido web completo"}'],
  ["evidence/gemini/argument.md", "Argumento de Gemini"],
  ["evidence/chatgpt/fragment.md", "Fragmento de ChatGPT"],
  ["evidence/claude/runs/1/transcript.jsonl", ""],
  ["evidence/base/raw/checksum.txt", "123456789"],
]);

test("archives the entire evidence tree with reproducible UTF-8 paths and original bytes", async () => {
  const zip = await createEvidenceArchive(files);
  assert.deepEqual(zip, await createEvidenceArchive(new Map([...files].reverse())));
  const extracted = unzip(zip);
  assert.equal(extracted.size, files.size);
  for (const [path, content] of files) {
    assert.deepEqual(extracted.get(path), Buffer.from(content));
  }
});

test("refuses missing base indexes and unsafe extraction paths", async () => {
  await assert.rejects(createEvidenceArchive(new Map()), /índice base/);
  for (const path of ["evidence/../outside.txt", "evidence/base/..\\outside", "evidence/base/file:stream", "evidence/base/a\u0000b"]) {
    await assert.rejects(createEvidenceArchive(new Map([["evidence/base/index.md", "index"], [path, "bad"]])));
  }
});

test("reads the final tree and uploads it, propagating read or write errors", async () => {
  const expected = { downloadUrl: "https://blob.test/expediente.zip?download=1", etag: "final" };
  let saved: Buffer | undefined;
  let transcript: string | undefined;
  const dependencies = {
    getEvents: async () => [],
    writeEvidenceTree: async () => {},
    writeCaseTranscript: async (_id: string, value: string) => { transcript = value; },
  };
  const result = await archiveEvidence("case-1", {
    ...dependencies,
    readEvidenceTree: async (id) => { assert.equal(id, "case-1"); return new Map([...files].map(([path, value]) => [path, Buffer.from(value)])); },
    writeEvidenceArchive: async (id, zip) => { assert.equal(id, "case-1"); saved = Buffer.from(zip); return expected; },
  });
  assert.deepEqual(result, expected);
  assert.ok(saved);
  assert.equal(unzip(saved).size, files.size + 2);
  assert.equal(unzip(saved).get("transcript.jsonl")!.toString(), transcript);
  assert.equal(unzip(saved).get("acta.jsonl")!.toString(), "");
  await assert.rejects(archiveEvidence("case-1", {
    ...dependencies,
    readEvidenceTree: async () => { throw new Error("read failed"); },
    writeEvidenceArchive: async () => { throw new Error("unexpected write"); },
  }), /read failed/);
  await assert.rejects(archiveEvidence("case-1", {
    ...dependencies,
    readEvidenceTree: async () => new Map([["evidence/base/index.md", Buffer.from("index")]]),
    writeEvidenceArchive: async () => { throw new Error("write failed"); },
  }), /write failed/);
  await assert.rejects(archiveEvidence("case-1", {
    ...dependencies,
    readEvidenceTree: async () => new Map([["evidence/base/index.md", Buffer.from("index")]]),
    writeCaseTranscript: async () => { throw new Error("transcript write failed"); },
    writeEvidenceArchive: async () => { throw new Error("unexpected write"); },
  }), /transcript write failed/);
});

test("persists the same merged transcript in the run, case blob and ZIP on retries", async () => {
  const run = "evidence/grok/runs/run-1/transcript.jsonl";
  const step = { at: "2026-01-01T00:00:00.000Z", step: 0, toolCalls: [] };
  const event: RecordedEvent = { type: "statement", id: "I1", by: "grok", stage: "opening", text: "Argumento", evidenceIds: [], evidenceRunId: "run-1", seq: 1, at: "2026-01-01T00:00:01.000Z" };
  const session: RecordedEvent = { type: "session_opened", judgeModel: "judge-id", counselModels: { grok: "grok-id", gemini: "gemini-id", claude: "claude-id", chatgpt: "chatgpt-id" }, seq: 0, at: "2025-01-01T00:00:00.000Z" };
  const stored = new Map<string, Uint8Array>([["evidence/base/index.md", Buffer.from("index")], [run, Buffer.from(JSON.stringify(step) + "\n")]]);
  let transcript = "";
  let zip = Buffer.alloc(0);
  let writes = 0;
  const store = {
    readEvidenceTree: async () => new Map(stored),
    getEvents: async () => [session, event],
    writeEvidenceTree: async (_id: string, updates: EvidenceFiles) => {
      writes++;
      for (const [path, content] of updates) stored.set(path, Buffer.from(content));
    },
    writeCaseTranscript: async (_id: string, value: string) => { transcript = value; },
    writeEvidenceArchive: async (_id: string, value: Uint8Array) => { zip = Buffer.from(value); return { downloadUrl: "url", etag: "v1" }; },
  };
  await archiveEvidence("case-1", store);
  const firstZip = zip;
  const extracted = unzip(zip);
  assert.deepEqual(extracted.get("acta.jsonl")!.toString().trim().split("\n").map((line) => JSON.parse(line)), [session, event]);
  assert.equal(extracted.get("transcript.jsonl")!.toString(), transcript);
  assert.equal(extracted.get(run)!.toString(), stored.get(run)!.toString());
  assert.deepEqual(extracted.get(run)!.toString().trim().split("\n").map((line) => JSON.parse(line)), [{ ...step, modelId: "grok-id", effort: null }, { ...event, modelId: "grok-id", effort: null }]);
  assert.deepEqual(transcript.trim().split("\n").map((line) => JSON.parse(line)), [{ ...step, modelId: "grok-id", effort: null, type: "evidence_step", seat: "grok", runId: "run-1" }, { ...event, modelId: "grok-id", effort: null }]);
  await archiveEvidence("case-1", store);
  assert.equal(writes, 1);
  assert.deepEqual(zip, firstZip);
});

test("reuses complete archives and rebuilds legacy archives when the evidence exists", async () => {
  const existing = { downloadUrl: "https://blob.test/expediente.zip?download=1", etag: "v1" };
  const legacy = { downloadUrl: "https://blob.test/legacy.zip?download=1", etag: "old" };
  let archived = 0;
  let hasBase = true;
  let found: typeof existing | undefined = existing;
  const store = {
    findCompleteEvidenceArchive: async () => found,
    findLegacyEvidenceArchive: async () => legacy,
    hasEvidenceBase: async () => hasBase,
    archiveEvidence: async (id: string) => { assert.equal(id, "old-case"); archived++; return existing; },
  };
  assert.deepEqual(await getOrCreateEvidenceArchive("old-case", store), existing);
  assert.equal(archived, 0);
  found = undefined;
  assert.deepEqual(await getOrCreateEvidenceArchive("old-case", store), existing);
  assert.equal(archived, 1);
  hasBase = false;
  assert.deepEqual(await getOrCreateEvidenceArchive("old-case", store), legacy);
  assert.equal(archived, 1);
});

test("downloads only resolved cases and redirects to the current stored version", async () => {
  let calls = 0;
  const getArchive = async () => { calls++; return { downloadUrl: "https://blob.test/expediente.zip?download=1", etag: "etag+1" }; };
  for (const status of [undefined, "queued", "in_session", "failed"] as const) {
    assert.equal((await evidenceDownloadResponse(status, true, getArchive)).status, 404);
  }
  assert.equal((await evidenceDownloadResponse("resolved", false, getArchive)).status, 404);
  assert.equal(calls, 0);
  assert.equal((await evidenceDownloadResponse("resolved", true, async () => undefined)).status, 404);
  const response = await evidenceDownloadResponse("resolved", true, getArchive);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.searchParams.get("download"), "1");
  assert.equal(location.searchParams.get("v"), "etag+1");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls, 1);
});
