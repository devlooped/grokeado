// Minimal client for the S3-compatible API of Cloudflare R2, signed with AWS Signature V4.
import { createHash, createHmac } from "node:crypto";

export type R2Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; publicUrl: string };
export type R2Object = { key: string; size: number; etag: string; lastModified: Date };
export type R2Head = R2Object & { contentType?: string };

export class R2Error extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function r2Config(): R2Config | undefined {
  const { R2_ACCOUNT_ID, R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL } = process.env;
  const endpoint = R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
  if (!endpoint || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_URL) return undefined;
  return { endpoint: endpoint.replace(/\/+$/, ""), bucket: R2_BUCKET, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, publicUrl: R2_PUBLIC_URL.replace(/\/+$/, "") };
}

function requireConfig(): R2Config {
  const config = r2Config();
  if (!config) throw new Error("R2 credentials are not configured. Set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_URL.");
  return config;
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export const encodeKey = (key: string) => key.split("/").map(encode).join("/");

// The public URL of an object. Keys are stored as given, so each segment is encoded once more.
export function publicUrl(key: string): string {
  return `${requireConfig().publicUrl}/${encodeKey(key)}`;
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

// Returns the Authorization header for a request whose headers already include
// x-amz-date and x-amz-content-sha256. Every given header is signed, plus host.
export function signV4(input: { method: string; url: URL; headers: Record<string, string>; accessKeyId: string; secretAccessKey: string; region: string; service?: string }): string {
  const service = input.service ?? "s3";
  const amzDate = input.headers["x-amz-date"]!;
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: input.url.host };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const query = [...input.url.searchParams].map(([name, value]) => [encode(name), encode(value)]).sort(([a, x], [b, y]) => a! < b! ? -1 : a! > b! ? 1 : x! < y! ? -1 : x! > y! ? 1 : 0).map(([name, value]) => `${name}=${value}`).join("&");
  const canonical = [input.method, input.url.pathname, query, ...names.map((name) => `${name}:${headers[name]}`), "", names.join(";"), input.headers["x-amz-content-sha256"]].join("\n");
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), service), "aws4_request");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`;
}

async function send(method: string, key: string | undefined, options: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array | string } = {}): Promise<Response> {
  const config = requireConfig();
  const url = new URL(`${config.endpoint}/${encode(config.bucket)}${key === undefined ? "" : `/${encodeKey(key)}`}`);
  const query = Object.entries(options.query ?? {}).map(([name, value]) => `${encode(name)}=${encode(value)}`).join("&");
  if (query) url.search = query;
  const body = typeof options.body === "string" ? new TextEncoder().encode(options.body) : options.body;
  const headers: Record<string, string> = {
    ...options.headers,
    "x-amz-content-sha256": sha256Hex(body ?? ""),
    "x-amz-date": new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""),
  };
  headers.authorization = signV4({ method, url, headers, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: "auto" });
  return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, cache: "no-store" });
}

const xmlText = (value: string) => value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi, (_, hex: string, dec: string, name: string) =>
  hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()]!);
const xmlEscape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const xmlField = (xml: string, name: string) => { const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return match ? xmlText(match[1]!) : undefined; };

async function fail(response: Response, action: string): Promise<never> {
  const text = await response.text().catch(() => "");
  const code = xmlField(text, "Code") ?? (response.statusText || "Error");
  throw new R2Error(response.status, code, `R2 ${action} failed: ${response.status} ${code}`);
}

const etagOf = (response: Response) => (response.headers.get("etag") ?? "").replace(/"/g, "");

// Lists one page of at most 1000 objects; pass the returned cursor to get the next page.
export async function listObjects(prefix: string, cursor?: string, maxKeys = 1000): Promise<{ objects: R2Object[]; cursor?: string }> {
  const response = await send("GET", undefined, { query: { "list-type": "2", prefix, "max-keys": String(maxKeys), ...(cursor ? { "continuation-token": cursor } : {}) } });
  if (!response.ok) await fail(response, "list");
  const xml = await response.text();
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, entry]) => ({
    key: xmlField(entry!, "Key")!,
    size: Number(xmlField(entry!, "Size")),
    etag: (xmlField(entry!, "ETag") ?? "").replace(/"/g, ""),
    lastModified: new Date(xmlField(entry!, "LastModified")!),
  }));
  const next = xmlField(xml, "IsTruncated") === "true" ? xmlField(xml, "NextContinuationToken") : undefined;
  if (xmlField(xml, "IsTruncated") === "true" && (!next || next === cursor)) throw new Error("R2 list pagination failed");
  return { objects, cursor: next };
}

export async function listAllObjects(prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await listObjects(prefix, cursor);
    objects.push(...page.objects);
    cursor = page.cursor;
  } while (cursor);
  return objects;
}

export async function headObject(key: string): Promise<R2Head | undefined> {
  const response = await send("HEAD", key);
  if (response.status === 404) return undefined;
  if (!response.ok) await fail(response, "head");
  return {
    key,
    size: Number(response.headers.get("content-length") ?? 0),
    etag: etagOf(response),
    lastModified: new Date(response.headers.get("last-modified") ?? 0),
    contentType: response.headers.get("content-type") ?? undefined,
  };
}

export async function getObject(key: string): Promise<Uint8Array | undefined> {
  const response = await send("GET", key);
  if (response.status === 404) return undefined;
  if (!response.ok) await fail(response, "get");
  return new Uint8Array(await response.arrayBuffer());
}

// Without overwrite, an existing key fails with a 412 PreconditionFailed R2Error.
export async function putObject(key: string, body: Uint8Array | string, options: { contentType: string; cacheControl?: string; contentDisposition?: string; overwrite: boolean }): Promise<{ etag: string }> {
  const headers: Record<string, string> = { "content-type": options.contentType };
  if (options.cacheControl) headers["cache-control"] = options.cacheControl;
  if (options.contentDisposition) headers["content-disposition"] = options.contentDisposition;
  if (!options.overwrite) headers["if-none-match"] = "*";
  const response = await send("PUT", key, { headers, body });
  if (!response.ok) await fail(response, "put");
  return { etag: etagOf(response) };
}

// Copies keep the content type, cache control and disposition of the source.
export async function copyObject(from: string, to: string): Promise<void> {
  const response = await send("PUT", to, { headers: { "x-amz-copy-source": `/${encode(requireConfig().bucket)}/${encodeKey(from)}` } });
  const text = response.ok ? await response.text() : "";
  if (!response.ok || text.includes("<Error>")) {
    const code = xmlField(text, "Code");
    if (code) throw new R2Error(response.status, code, `R2 copy failed: ${code}`);
    await fail(response, "copy");
  }
}

export async function deleteObjects(keys: readonly string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 1000) {
    const body = `<Delete><Quiet>true</Quiet>${keys.slice(index, index + 1000).map((key) => `<Object><Key>${xmlEscape(key)}</Key></Object>`).join("")}</Delete>`;
    const response = await send("POST", undefined, {
      query: { delete: "" },
      headers: { "content-type": "application/xml", "content-md5": createHash("md5").update(body).digest("base64") },
      body,
    });
    if (!response.ok) await fail(response, "delete");
    const text = await response.text();
    const error = /<Error>([\s\S]*?)<\/Error>/.exec(text);
    if (error) throw new R2Error(response.status, xmlField(error[1]!, "Code") ?? "Error", `R2 delete failed for ${xmlField(error[1]!, "Key")}`);
  }
}
