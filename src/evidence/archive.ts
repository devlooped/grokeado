import { deflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { getCase, getCaseAuditRecords, getEvents, getSourceOperations } from "../store.ts";
import { caseArtifactStore, findEvidenceArchive, hasEvidenceBase, readEvidenceTree, writeCaseTranscript, writeEvidenceArchive, writeEvidenceTree, type EvidenceArchive } from "./blob.ts";
import { buildCaseTranscript } from "./transcript.ts";
import { normalizeEvidenceBytes, type EvidenceFiles } from "./validate.ts";
import { normalizeArtifactBytes, type ArtifactStore } from "./artifacts.ts";
import { buildCaseLog } from "./case-log.ts";
import { loadSettledCorpus } from "./settled.ts";
import { caseUsageArtifact } from "../domain/usage.ts";

const compress = promisify(deflateRaw);
const MAX_ZIP_VALUE = 0xffffffff;
const UTF8 = 0x0800;
const DOS_DATE = 0x0021; // 1980-01-01, for reproducible archives.

// ZIP uses the IEEE CRC-32 polynomial. Node 20 does not provide zlib.crc32.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

// Write a standard ZIP with UTF-8 paths, deflated contents, and a central directory.
// Reject ZIP64 sizes rather than emit a truncated archive.
export async function createEvidenceArchive(files: EvidenceFiles): Promise<Buffer> {
  const settled = files.has("case.jsonl");
  if (settled ? !files.has("instruction/base/submission.json") : !files.has("evidence/base/index.md")) throw new Error("El expediente no contiene el índice base.");
  if (settled && [...files.keys()].some((path) => /(?:^|\/)(?:acta|transcript)\.jsonl$/.test(path))) throw new Error("New archives contain only one public case.jsonl log");
  if (files.size >= 0xffff) throw new Error("El expediente contiene demasiados archivos para un ZIP.");

  const entries: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const bytes = settled || path === "case.json" ? normalizeArtifactBytes(path, content) : path === "transcript.jsonl" || path === "acta.jsonl" ? (typeof content === "string" ? Buffer.from(content) : content) : normalizeEvidenceBytes(path, content);
    if (/[:\x00-\x1f]/.test(path)) throw new Error(`Invalid archive path: ${path}`);
    const name = Buffer.from(path, "utf8");
    if (name.length > 0xffff) throw new Error(`Archive path is too long: ${path}`);
    const data = await compress(bytes);
    const checksum = crc32(bytes);
    if (data.length >= MAX_ZIP_VALUE || offset + 30 + name.length + data.length >= MAX_ZIP_VALUE) {
      throw new Error("El expediente es demasiado grande para un ZIP.");
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.byteLength, 22);
    local.writeUInt16LE(name.length, 26);
    entries.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(bytes.byteLength, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const directorySize = directory.reduce((size, part) => size + part.length, 0);
  if (directorySize >= MAX_ZIP_VALUE || offset + directorySize >= MAX_ZIP_VALUE) {
    throw new Error("El expediente es demasiado grande para un ZIP.");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, ...directory, end]);
}

type ArchiveStore = {
  readEvidenceTree: typeof readEvidenceTree;
  getEvents: typeof getEvents;
  writeEvidenceTree: typeof writeEvidenceTree;
  writeCaseTranscript: typeof writeCaseTranscript;
  writeEvidenceArchive: typeof writeEvidenceArchive;
  getCase?: typeof getCase;
  getCaseAuditRecords?: typeof getCaseAuditRecords;
  getSourceOperations?: typeof getSourceOperations;
  artifacts?: ArtifactStore;
};

export async function archiveEvidence(caseId: string, store: ArchiveStore = { readEvidenceTree, getEvents, writeEvidenceTree, writeCaseTranscript, writeEvidenceArchive, getCase, getCaseAuditRecords, getSourceOperations, artifacts: caseArtifactStore }): Promise<EvidenceArchive> {
  if ((await store.getCase?.(caseId))?.pipelineVersion === 2) {
    if (!store.artifacts || !store.getCaseAuditRecords || !store.getSourceOperations) throw new Error("Durable new-format archive storage unavailable");
    const events = await store.getEvents(caseId);
    if (!events.some((event) => event.type === "dismissed")) await loadSettledCorpus(caseId, events, store.artifacts);
    const audit = await store.getCaseAuditRecords(caseId);
    const log = buildCaseLog(events, audit, await store.getSourceOperations(caseId));
    await store.artifacts.write(caseId, new Map([["case.jsonl", log], ["case.json", JSON.stringify(caseUsageArtifact(caseId, audit), null, 2)]]));
    const files = await store.artifacts.read(caseId);
    for (const path of files.keys()) if (/(?:^|\/)(?:acta|transcript)\.jsonl$/.test(path)) files.delete(path);
    return store.writeEvidenceArchive(caseId, await createEvidenceArchive(files));
  }
  const files = await store.readEvidenceTree(caseId);
  const events = await store.getEvents(caseId);
  const { transcript, updatedRuns } = buildCaseTranscript(files, events);
  for (const [path, content] of updatedRuns) files.set(path, new TextEncoder().encode(content));
  files.set("transcript.jsonl", new TextEncoder().encode(transcript));
  files.set("acta.jsonl", new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "")));
  const usage = JSON.stringify(caseUsageArtifact(caseId, await store.getCaseAuditRecords?.(caseId) ?? []), null, 2);
  files.set("case.json", new TextEncoder().encode(usage));
  await store.artifacts?.write(caseId, new Map([["case.json", usage]]));
  const zip = await createEvidenceArchive(files);
  if (updatedRuns.size) await store.writeEvidenceTree(caseId, updatedRuns);
  await store.writeCaseTranscript(caseId, transcript);
  return store.writeEvidenceArchive(caseId, zip);
}

type ArchiveLookup = {
  findEvidenceArchive: typeof findEvidenceArchive;
  hasEvidenceBase: typeof hasEvidenceBase;
  archiveEvidence: typeof archiveEvidence;
};

// Rebuild a missing case.zip from the stored evidence and events without overwriting an existing one.
export async function getOrCreateEvidenceArchive(caseId: string, store: ArchiveLookup = { findEvidenceArchive, hasEvidenceBase, archiveEvidence }): Promise<EvidenceArchive | undefined> {
  const existing = await store.findEvidenceArchive(caseId);
  if (existing) return existing;
  if (!await store.hasEvidenceBase(caseId)) return undefined;
  return store.archiveEvidence(caseId);
}
