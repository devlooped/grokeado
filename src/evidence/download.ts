import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Impit } from "impit";
import { browserbaseConfigured, downloadWithBrowserbase } from "./browserbase.ts";

export type DownloadVia = "impit" | "fetch" | "browserbase";

export type DownloadResult =
  | {
      ok: true;
      bytes: Uint8Array;
      contentType: string;
      finalUrl: string;
      redirects: number;
      via?: DownloadVia;
      screenshot?: Uint8Array;
    }
  | { ok: false; error: string; status?: number };

export type PublicUrlCheck = (raw: string) => Promise<{ ok: true; url: string } | { ok: false; error: string }>;

export type BrowserFetchOptions = {
  assertPublic: PublicUrlCheck;
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
};

export type BrowserFetch = (rawUrl: string, options: BrowserFetchOptions) => Promise<DownloadResult>;

export const DOWNLOAD_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxRedirects: 5,
  timeoutMs: 15_000,
  browserTimeoutMs: 30_000,
} as const;

type Lookup = (hostname: string) => Promise<readonly string[]>;
type ResponseLike = {
  status: number;
  headers: Pick<Headers, "get">;
  body: ReadableStream<Uint8Array> | null;
};
type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const ESCALATION_STATUSES = new Set([401, 403, 406, 429, 500, 502, 503, 520, 521, 522, 523, 524, 525, 526]);
const BROWSER_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8",
  "accept-language": "es-AR,es;q=0.9,en;q=0.8",
} as const;

let sharedImpit: Impit | undefined;

function impitFetch(): FetchLike {
  sharedImpit ??= new Impit({ browser: "chrome", followRedirects: false });
  const client = sharedImpit;
  return (url, init) =>
    client.fetch(url, {
      method: "GET",
      headers: init.headers as Record<string, string> | undefined,
      signal: init.signal ?? undefined,
    });
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0] ?? "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return isBlockedAddress(mapped[1]);
  const kind = isIP(normalized);
  if (kind === 4) return isPrivateV4(normalized);
  if (kind === 6) return isPrivateV6(normalized);
  return true;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateV6(address: string): boolean {
  if (address === "::1" || address === "::") return true;
  const head = address.split(":")[0] ?? "";
  if (head.startsWith("fe8") || head.startsWith("fe9") || head.startsWith("fea") || head.startsWith("feb")) return true;
  if (head.startsWith("fc") || head.startsWith("fd") || head.startsWith("ff")) return true;
  return false;
}

async function defaultLookup(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname];
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function assertPublicUrl(raw: string, resolve: Lookup): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "URL is not valid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Only http and https URLs can be downloaded" };
  if (url.username || url.password) return { ok: false, error: "URLs with credentials are rejected" };
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal" || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return { ok: false, error: "URL resolves to a non-public address" };
  }
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, error: "Could not resolve host" };
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) return { ok: false, error: "URL resolves to a non-public address" };
  return { ok: true, url: url.toString() };
}

async function readLimited(response: ResponseLike, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, error: "Downloaded file is empty" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, error: "Response exceeds the size limit" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: "Download failed" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function visibleHtmlWordCount(html: string): number {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .trim();
  return text ? text.split(/\s+/).length : 0;
}

const CHALLENGE_MARKERS =
  /__cf_chl_|\/cdn-cgi\/challenge-platform|cf-browser-verification|attention required!\s*\|\s*cloudflare|<title>\s*just a moment|checking your browser before accessing|captcha-delivery\.com|px-captcha|_incapsula_resource/i;
const SPA_MOUNT_MARKERS = /\bid=["'](?:root|__next|__nuxt|app)["']|\bdata-reactroot\b|\bng-version=/i;
const JS_REQUIRED_MARKERS =
  /enable javascript|javascript is required|turn on javascript|you need to enable javascript|habilit[aá]\s+javascript|activar\s+javascript|requiere\s+javascript/i;
const CAPTCHA_WIDGET_MARKERS = /\b(?:cf-turnstile|g-recaptcha|h-captcha)\b/i;

export function shouldEscalateToBrowser(result: DownloadResult): boolean {
  if (!result.ok) {
    if (result.status !== undefined) return ESCALATION_STATUSES.has(result.status);
    return (
      result.error === "Download failed" ||
      result.error === "Download timed out" ||
      result.error === "Downloaded file is empty"
    );
  }
  let pathname = "";
  try {
    pathname = new URL(result.finalUrl).pathname;
  } catch {
    return false;
  }
  const ext = sniffExtension(result.bytes, result.contentType, pathname);
  if (ext !== "html" && ext !== "htm") return false;

  const html = new TextDecoder().decode(result.bytes);
  if (CHALLENGE_MARKERS.test(html)) return true;

  const words = visibleHtmlWordCount(html);
  if (words < 120 && CAPTCHA_WIDGET_MARKERS.test(html)) return true;
  if (words < 40 && JS_REQUIRED_MARKERS.test(html)) return true;
  if (words < 40 && /<script\b/i.test(html) && SPA_MOUNT_MARKERS.test(html)) return true;
  return false;
}

async function directDownload(rawUrl: string, options: {
  fetchImpl: FetchLike;
  via: DownloadVia;
  resolve: Lookup;
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
}): Promise<DownloadResult> {
  const { fetchImpl, via, resolve, maxBytes, maxRedirects, timeoutMs } = options;
  let current = rawUrl;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const allowed = await assertPublicUrl(current, resolve);
    if (!allowed.ok) return allowed;
    let response: ResponseLike;
    try {
      response = await fetchImpl(allowed.url, {
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(timeoutMs),
        headers: BROWSER_HEADERS,
      });
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError" || /timed?\s*out/i.test(error.message));
      return { ok: false, error: timedOut ? "Download timed out" : "Download failed" };
    }
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) return { ok: false, error: "Redirect is missing a location", status: response.status };
      if (redirects === maxRedirects) return { ok: false, error: "Too many redirects", status: response.status };
      current = new URL(location, allowed.url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      return { ok: false, error: `HTTP ${response.status}`, status: response.status };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      return { ok: false, error: "Response exceeds the size limit", status: response.status };
    }
    const body = await readLimited(response, maxBytes);
    if (!body.ok) return { ...body, status: response.status };
    if (!body.bytes.byteLength) return { ok: false, error: "Downloaded file is empty", status: response.status };
    return {
      ok: true,
      bytes: body.bytes,
      contentType: response.headers.get("content-type") ?? "",
      finalUrl: allowed.url,
      redirects,
      via,
    };
  }
  return { ok: false, error: "Too many redirects" };
}

export async function downloadUrl(rawUrl: string, options?: {
  fetchImpl?: typeof fetch;
  browserFetch?: BrowserFetch;
  escalate?: boolean;
  lookup?: Lookup;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  browserTimeoutMs?: number;
}): Promise<DownloadResult> {
  const fetchImpl: FetchLike = options?.fetchImpl ?? impitFetch();
  const via: DownloadVia = options?.fetchImpl ? "fetch" : "impit";
  const resolve = options?.lookup ?? defaultLookup;
  const maxBytes = options?.maxBytes ?? DOWNLOAD_LIMITS.maxBytes;
  const maxRedirects = options?.maxRedirects ?? DOWNLOAD_LIMITS.maxRedirects;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_LIMITS.timeoutMs;

  const tier1 = await directDownload(rawUrl, { fetchImpl, via, resolve, maxBytes, maxRedirects, timeoutMs });
  if (options?.escalate === false || !shouldEscalateToBrowser(tier1)) return tier1;

  const browserFetch =
    options?.browserFetch ?? (!options?.fetchImpl && browserbaseConfigured() ? downloadWithBrowserbase : undefined);
  if (!browserFetch) return tier1;

  const tier2 = await browserFetch(rawUrl, {
    assertPublic: (candidate) => assertPublicUrl(candidate, resolve),
    maxBytes,
    maxRedirects,
    timeoutMs: options?.browserTimeoutMs ?? Math.max(timeoutMs, DOWNLOAD_LIMITS.browserTimeoutMs),
  });
  if (tier2.ok) return tier2;
  if (/non-public|credentials|Only http|not valid/i.test(tier2.error)) return tier2;
  return tier1;
}

export function sniffExtension(bytes: Uint8Array, contentType: string, pathname: string): string {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "pdf";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "webp";
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "text/plain") return "txt";
  if (type === "text/csv") return "csv";
  if (type === "application/pdf") return "pdf";
  const filename = pathname.split("/").pop() ?? "";
  const fromPath = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() ?? "" : "";
  if (/^[a-z0-9]{1,8}$/.test(fromPath)) return fromPath;
  return "bin";
}
