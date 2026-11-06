// In-memory stand-in for the R2 S3 API, used by tests through R2_ENDPOINT.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeObject = { body: Buffer; contentType: string; cacheControl?: string; contentDisposition?: string; etag: string; lastModified: Date };
export type FakeRequest = { method: string; key?: string; query: URLSearchParams; headers: IncomingMessage["headers"] };

const xml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const unxml = (value: string) => value.replace(/&#(\d+);|&(lt|gt|amp|quot|apos);/g, (_, code: string, name: string) => code ? String.fromCharCode(Number(code)) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[name]!);

export async function startFakeR2(options: { pageSize?: number } = {}) {
  const objects = new Map<string, FakeObject>();
  const requests: FakeRequest[] = [];
  const state = { deny: false };
  let clock = Date.parse("2026-11-05T00:00:00.000Z");
  const store = (key: string, body: Buffer, meta: Partial<FakeObject> = {}) => {
    clock += 1000;
    objects.set(key, { contentType: "application/octet-stream", ...meta, body, etag: createHash("md5").update(body).digest("hex"), lastModified: new Date(clock) });
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const [, bucket, ...rest] = url.pathname.split("/").map(decodeURIComponent);
    const key = rest.length ? rest.join("/") : undefined;
    requests.push({ method: request.method!, key, query: url.searchParams, headers: request.headers });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const reply = (status: number, text = "", headers: Record<string, string> = {}) => { response.writeHead(status, { "content-type": "application/xml", ...headers }); response.end(text); };
    const error = (status: number, code: string) => reply(status, `<Error><Code>${code}</Code></Error>`);
    if (state.deny || bucket !== "test-bucket" || !String(request.headers.authorization).startsWith("AWS4-HMAC-SHA256 Credential=test-key/")) return error(403, "AccessDenied");

    if (key === undefined && request.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const size = options.pageSize ?? 1000;
      const page = keys.slice(start, start + size);
      const truncated = start + size < keys.length;
      const contents = page.map((name) => { const object = objects.get(name)!; return `<Contents><Key>${xml(name)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>"${object.etag}"</ETag><Size>${object.body.byteLength}</Size></Contents>`; }).join("");
      return reply(200, `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${start + size}</NextContinuationToken>` : ""}</ListBucketResult>`);
    }
    if (key === undefined && request.method === "POST" && url.searchParams.has("delete")) {
      for (const [, name] of body.toString().matchAll(/<Key>([\s\S]*?)<\/Key>/g)) objects.delete(unxml(name!));
      return reply(200, "<DeleteResult></DeleteResult>");
    }
    if (key === undefined) return error(400, "InvalidRequest");

    if (request.method === "PUT") {
      const source = request.headers["x-amz-copy-source"];
      if (source) {
        const from = String(source).split("/").slice(2).map(decodeURIComponent).join("/");
        const object = objects.get(from);
        if (!object) return error(404, "NoSuchKey");
        store(key, object.body, object);
        return reply(200, "<CopyObjectResult></CopyObjectResult>");
      }
      if (request.headers["if-none-match"] === "*" && objects.has(key)) return error(412, "PreconditionFailed");
      store(key, body, {
        contentType: String(request.headers["content-type"]),
        cacheControl: request.headers["cache-control"],
        contentDisposition: request.headers["content-disposition"],
      });
      return reply(200, "", { etag: `"${objects.get(key)!.etag}"` });
    }
    const object = objects.get(key);
    if (!object) return error(404, "NoSuchKey");
    const headers = { "content-type": object.contentType, etag: `"${object.etag}"`, "last-modified": object.lastModified.toUTCString(), "content-length": String(object.body.byteLength) };
    if (request.method === "HEAD") { response.writeHead(200, headers); response.end(); return; }
    if (request.method === "GET") { response.writeHead(200, headers); response.end(object.body); return; }
    return error(405, "MethodNotAllowed");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const names = ["R2_ENDPOINT", "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { R2_ENDPOINT: endpoint, R2_BUCKET: "test-bucket", R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret", R2_PUBLIC_URL: "https://public.test" });
  delete process.env.R2_ACCOUNT_ID;

  return {
    objects,
    requests,
    state,
    store,
    async close() {
      for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
