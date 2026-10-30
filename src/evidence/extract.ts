import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

export type Transcript = { text: string; confidence: number; tool: string };
export type Recognize = (bytes: Uint8Array, mimeType: string) => Promise<Transcript>;

export type PageText = { page: number; text: string; confidence: number; tool: string; csv?: string };
export type PdfExtraction =
  | { ok: true; pages: PageText[]; tool: string; confidence: number }
  | { ok: false; error: string };

type RawObject = { id: number; dict: string; stream?: Uint8Array };

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

function decodeLiteral(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const next = body[++i];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (next !== undefined && next >= "0" && next <= "7") {
      let octal = next;
      for (let extra = 0; extra < 2 && body[i + 1] !== undefined && body[i + 1]! >= "0" && body[i + 1]! <= "7"; extra++) octal += body[++i];
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else if (next !== undefined) out += next;
  }
  return out;
}

function decodeHex(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  if (!clean || clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return "";
  const bytes = Buffer.from(clean, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) text += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return text;
  }
  return bytes.toString("latin1");
}

function stringsFromArray(inner: string): string {
  let out = "";
  for (const match of inner.matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>/g)) {
    out += match[1] !== undefined ? decodeLiteral(match[1]) : decodeHex(match[2] ?? "");
  }
  return out;
}

function textFromContent(content: Uint8Array): string {
  const source = latin1(content);
  let text = "";
  for (const match of source.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:\\.|[^\\\]])*)\]\s*TJ|<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
    if (match[1] !== undefined) text += decodeLiteral(match[1]);
    else if (match[2] !== undefined) text += stringsFromArray(match[2]);
    else text += decodeHex(match[3] ?? "");
    text += "\n";
  }
  return text.trim();
}

function decodedStream(dict: string, stream: Uint8Array): Uint8Array {
  if (/\/FlateDecode\b/.test(dict)) return inflateSync(stream);
  return stream;
}

function integerObject(dict: string): number {
  const match = /^\s*(\d+)\s*$/.exec(dict);
  if (!match) throw new Error("Malformed PDF: length is not an integer");
  return Number(match[1]);
}

function xrefEntries(source: string): Map<number, number> | undefined {
  const start = source.lastIndexOf("startxref");
  if (start < 0) return undefined;
  const offset = Number(/\d+/.exec(source.slice(start + "startxref".length))?.[0]);
  if (!Number.isInteger(offset) || offset < 0 || offset >= source.length) return undefined;
  const table = source.slice(offset);
  if (!table.startsWith("xref")) return undefined;
  const lines = table.split(/\r?\n/);
  const entries = new Map<number, number>();
  let index = 1;
  while (index < lines.length && lines[index] && !lines[index]!.startsWith("trailer")) {
    const header = /^(\d+)\s+(\d+)$/.exec(lines[index]!);
    if (!header) return undefined;
    const startId = Number(header[1]);
    const count = Number(header[2]);
    index++;
    for (let i = 0; i < count; i++) {
      const entry = /^(\d{10}) (\d{5}) ([nf])/.exec(lines[index++] ?? "");
      if (!entry) return undefined;
      if (entry[3] === "n") entries.set(startId + i, Number(entry[1]));
    }
  }
  return entries.size ? entries : undefined;
}

function parseObjectAt(bytes: Uint8Array, offset: number, lengthOf: (id: number) => number): RawObject {
  const source = latin1(bytes);
  const header = /^(\d+)\s+\d+\s+obj/.exec(source.slice(offset));
  if (!header) throw new Error("Malformed PDF: missing object");
  const cursor = offset + header[0].length;
  const rest = source.slice(cursor);
  const streamRel = rest.search(/(?:^|[\r\n])stream(?:\r\n|\n|\r)/);
  const endRel = rest.indexOf("endobj");
  if (endRel < 0) throw new Error("Malformed PDF: truncated object");
  if (streamRel >= 0 && streamRel < endRel) {
    const dict = rest.slice(0, streamRel);
    const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict);
    const direct = /\/Length\s+(\d+)\b/.exec(dict);
    const length = indirect ? lengthOf(Number(indirect[1])) : direct ? Number(direct[1]) : Number.NaN;
    if (!Number.isInteger(length) || length < 0) throw new Error("Malformed PDF: missing stream length");
    const keyword = /(?:^|[\r\n])stream(?:\r\n|\n|\r)/.exec(rest.slice(streamRel));
    if (!keyword) throw new Error("Malformed PDF: broken stream");
    const dataStart = cursor + streamRel + keyword.index + keyword[0].length;
    const stream = bytes.subarray(dataStart, dataStart + length);
    if (stream.byteLength !== length) throw new Error("Malformed PDF: truncated stream");
    return { id: Number(header[1]), dict, stream };
  }
  return { id: Number(header[1]), dict: rest.slice(0, endRel) };
}

function parseWithXref(bytes: Uint8Array): RawObject[] | undefined {
  const entries = xrefEntries(latin1(bytes));
  if (!entries) return undefined;
  const cache = new Map<number, RawObject>();
  const reading = new Set<number>();
  const lengthOf = (id: number): number => integerObject(load(id).dict);
  const load = (id: number): RawObject => {
    const cached = cache.get(id);
    if (cached) return cached;
    if (reading.has(id)) throw new Error("Malformed PDF: cyclic length");
    const offset = entries.get(id);
    if (offset === undefined) throw new Error("Malformed PDF: missing object");
    reading.add(id);
    const object = parseObjectAt(bytes, offset, lengthOf);
    reading.delete(id);
    cache.set(id, object);
    return object;
  };
  for (const id of entries.keys()) load(id);
  return [...cache.values()];
}

function parseByScan(bytes: Uint8Array): RawObject[] {
  const source = latin1(bytes);
  if (!source.includes("%PDF-")) throw new Error("Malformed PDF: missing header");
  const objects: RawObject[] = [];
  const marker = /(\d+)\s+\d+\s+obj/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source))) {
    const object = parseObjectAt(bytes, match.index, () => {
      throw new Error("Malformed PDF: indirect lengths need an xref table");
    });
    objects.push(object);
    const end = source.indexOf("endobj", match.index);
    if (end < 0) throw new Error("Malformed PDF: truncated object");
    marker.lastIndex = end + "endobj".length;
  }
  if (!objects.length) throw new Error("Malformed PDF: no objects");
  return objects;
}

function orderedPages(objects: readonly RawObject[]): RawObject[] {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const ordered: RawObject[] = [];
  const seen = new Set<number>();
  const isPage = (dict: string) => /\/Type\s*\/Page\b/.test(dict) && !/\/Type\s*\/Pages\b/.test(dict);
  const visit = (id: number) => {
    const object = byId.get(id);
    if (!object || seen.has(id)) return;
    seen.add(id);
    if (isPage(object.dict)) {
      ordered.push(object);
      return;
    }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(object.dict);
    if (!kids) return;
    for (const ref of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) visit(Number(ref[1]));
  };
  const catalog = objects.find((object) => /\/Type\s*\/Catalog\b/.test(object.dict));
  const pages = catalog && /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalog.dict);
  if (pages) visit(Number(pages[1]));
  return ordered.length ? ordered : objects.filter((object) => isPage(object.dict));
}

function contentStreams(page: RawObject, objects: readonly RawObject[]): Uint8Array[] {
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(page.dict);
  const ids = array ? [...array[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1])) : single ? [Number(single[1])] : [];
  return ids.flatMap((id) => {
    const object = objects.find((candidate) => candidate.id === id);
    return object?.stream ? [decodedStream(object.dict, object.stream)] : [];
  });
}

function pageHasImage(dict: string, content: string, objects: readonly RawObject[]): boolean {
  if (/\/XObject\b/.test(dict) || /\/\w+\s+Do\b/.test(content)) return true;
  return [...dict.matchAll(/(\d+)\s+\d+\s+R/g)].some((match) => {
    const object = objects.find((candidate) => candidate.id === Number(match[1]));
    return object ? /\/Subtype\s*\/Image\b/.test(object.dict) : false;
  });
}

function imageBytes(dict: string, objects: readonly RawObject[]): { bytes: Uint8Array; mime: string } | undefined {
  for (const match of dict.matchAll(/(\d+)\s+\d+\s+R/g)) {
    const object = objects.find((candidate) => candidate.id === Number(match[1]));
    if (!object?.stream || !/\/Subtype\s*\/Image\b/.test(object.dict)) continue;
    const bytes = /\/FlateDecode\b/.test(object.dict) ? inflateSync(object.stream) : object.stream;
    const mime = /\/DCTDecode\b/.test(object.dict) ? "image/jpeg" : "application/octet-stream";
    return { bytes, mime };
  }
  return undefined;
}

export function tableCsv(text: string): string | undefined {
  const rows = text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.includes("|") || /^[\s|:-]+$/.test(trimmed)) return [];
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    return cells.length >= 2 ? [cells] : [];
  });
  if (rows.length < 2 || !rows.every((row) => row.length === rows[0]!.length)) return undefined;
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

export function renderMarkedPages(pages: readonly { page: number; text: string }[]): string {
  if (!pages.length) return "";
  return pages.map((page) => `[p.${page.page}]\n\n${page.text.trim()}`).join("\n\n") + "\n";
}

function isoDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

export function extractTimeline(text: string): string {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const iso = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) found.add(iso);
  }
  for (const match of text.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/g)) {
    const iso = isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
    if (iso) found.add(iso);
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+de\s+(\d{4})\b/g)) {
    const month = MONTHS[match[2]!.toLocaleLowerCase("es")];
    if (!month) continue;
    const iso = isoDate(Number(match[3]), month, Number(match[1]));
    if (iso) found.add(iso);
  }
  const lines = ["# Timeline", ""];
  if (!found.size) lines.push("No dates have been extracted from the submission.");
  else for (const date of [...found].sort()) lines.push(`- ${date}`);
  return lines.join("\n") + "\n";
}

export function extractEntities(text: string): string {
  const found = new Set<string>();
  for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) found.add(match[0]);
  for (const match of text.matchAll(/https?:\/\/[^\s)]+/gi)) found.add(match[0].replace(/[.,;]+$/, ""));
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])(\p{Lu}\p{Ll}+(?:[ \t]+\p{Lu}\p{Ll}+)+)(?![\p{L}\p{N}])/gu)) found.add(match[1] ?? match[0]);
  const lines = ["# Entities", ""];
  if (!found.size) lines.push("No entities have been extracted from the submission.");
  else for (const entity of [...found].sort((a, b) => a.localeCompare(b, "es"))) lines.push(`- ${entity}`);
  return lines.join("\n") + "\n";
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function confidenceFromTsv(tsv: string): { text: string; confidence: number } {
  const words = tsv.split(/\r?\n/).slice(1).flatMap((line) => {
    const cols = line.split("\t");
    if (cols[0] !== "5" || cols.length < 12) return [];
    const confidence = Number(cols[10]);
    const text = cols[11] ?? "";
    return text && Number.isFinite(confidence) && confidence >= 0 ? [{ text, confidence }] : [];
  });
  if (!words.length) return { text: "", confidence: 0 };
  const confidence = words.reduce((sum, word) => sum + word.confidence, 0) / words.length / 100;
  return { text: words.map((word) => word.text).join(" ").trim(), confidence: clamp01(confidence) };
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").slice(0, 500) || `${command} exited ${code}`));
    });
  });
}

export async function defaultRecognize(bytes: Uint8Array, mimeType: string): Promise<Transcript> {
  if (!bytes.byteLength) return { text: "", confidence: 0, tool: "ocr-unavailable" };
  const dir = await mkdtemp(join(tmpdir(), "evidence-ocr-"));
  const extension = mimeType.includes("png") ? "png" : mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "img";
  const input = join(dir, `page.${extension}`);
  try {
    await writeFile(input, bytes);
    const tsv = await execFileText("tesseract", [input, "stdout", "-l", "spa", "--psm", "6", "tsv"]);
    const parsed = confidenceFromTsv(tsv);
    return { text: parsed.text, confidence: parsed.confidence, tool: parsed.text ? "tesseract-spa" : "ocr-unavailable" };
  } catch {
    return { text: "", confidence: 0, tool: "ocr-unavailable" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function extractPdf(bytes: Uint8Array, recognize: Recognize = defaultRecognize): Promise<PdfExtraction> {
  try {
    if (!latin1(bytes).includes("%PDF-")) return { ok: false, error: "Malformed PDF: missing header" };
    const objects = parseWithXref(bytes) ?? parseByScan(bytes);
    const pages = orderedPages(objects);
    if (!pages.length) return { ok: false, error: "Malformed PDF: no pages" };
    const extracted: PageText[] = [];
    for (const [index, page] of pages.entries()) {
      const streams = contentStreams(page, objects);
      const combined = new Uint8Array(streams.reduce((total, stream) => total + stream.byteLength, 0));
      let offset = 0;
      for (const stream of streams) {
        combined.set(stream, offset);
        offset += stream.byteLength;
      }
      const text = textFromContent(combined);
      const content = latin1(combined);
      if (!text && pageHasImage(page.dict, content, objects)) {
        const embedded = imageBytes(page.dict, objects);
        const result = await recognize(embedded?.bytes ?? bytes, embedded?.mime ?? "application/pdf");
        const transcript = result.text.trim();
        extracted.push({ page: index + 1, text: transcript, confidence: clamp01(result.confidence), tool: result.tool, csv: tableCsv(transcript) });
      } else {
        extracted.push({ page: index + 1, text, confidence: text ? 0.95 : 0.5, tool: "pdf-text", csv: tableCsv(text) });
      }
    }
    return {
      ok: true,
      pages: extracted,
      tool: [...new Set(extracted.map((page) => page.tool))].join("+"),
      confidence: Math.min(...extracted.map((page) => page.confidence)),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Malformed PDF" };
  }
}
