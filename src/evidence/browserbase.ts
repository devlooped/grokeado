import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";
import type { BrowserFetchOptions, DownloadResult } from "./download.ts";

export function browserbaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BROWSERBASE_API_KEY?.trim());
}

function proxyPreference(env: NodeJS.ProcessEnv = process.env): "auto" | boolean {
  const raw = env.BROWSERBASE_PROXIES?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return "auto";
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || /timed?\s*out/i.test(error.message);
}

function isBinaryContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime) return false;
  if (mime === "text/html" || mime === "application/xhtml+xml") return false;
  return mime === "application/pdf" || mime.startsWith("image/") || mime === "text/csv" || mime === "text/plain";
}

async function createStealthSession(client: Browserbase, projectId?: string, proxies: "auto" | boolean = "auto") {
  const baseParams = {
    ...(projectId ? { projectId } : {}),
    browserSettings: {
      blockAds: true,
      solveCaptchas: true,
    },
  };
  if (proxies === "auto") {
    try {
      return await client.sessions.create({ ...baseParams, proxies: true });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 0;
      if (status === 400 || status === 402 || status === 403 || status === 422) {
        return await client.sessions.create(baseParams);
      }
      throw error;
    }
  }
  return await client.sessions.create(proxies ? { ...baseParams, proxies: true } : baseParams);
}

export async function downloadWithBrowserbase(rawUrl: string, options: BrowserFetchOptions): Promise<DownloadResult> {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "Browserbase is not configured" };

  const allowed = await options.assertPublic(rawUrl);
  if (!allowed.ok) return allowed;

  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim() || undefined;
  const client = new Browserbase({ apiKey, timeout: options.timeoutMs, maxRetries: 1 });

  let session: Awaited<ReturnType<typeof createStealthSession>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;

  try {
    session = await createStealthSession(client, projectId, proxyPreference());
    browser = await chromium.connectOverCDP(session.connectUrl, { timeout: options.timeoutMs });
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();

    const checkedOrigins = new Map<string, Promise<{ ok: true; url: string } | { ok: false; error: string }>>();
    const checkUrl = (target: string) => {
      let key = target;
      try {
        const parsed = new URL(target);
        if (!parsed.username && !parsed.password && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
          key = `${parsed.protocol}//${parsed.hostname}`;
        }
      } catch {
        // Invalid URLs fail fast in assertPublic below.
      }
      const existing = checkedOrigins.get(key);
      if (existing) return existing;
      const pending = options.assertPublic(target);
      checkedOrigins.set(key, pending);
      return pending;
    };

    let blockedMainError: string | undefined;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const target = request.url();
      if (target.startsWith("data:") || target.startsWith("blob:") || target === "about:blank") {
        await route.continue();
        return;
      }
      const check = await checkUrl(target);
      if (!check.ok) {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          blockedMainError = check.error;
        }
        await route.abort("accessdenied");
        return;
      }
      await route.continue();
    });

    let latestMainStatus: number | undefined;
    let latestMainContentType = "";
    page.on("response", (res) => {
      if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) {
        latestMainStatus = res.status();
        latestMainContentType = res.headers()["content-type"] ?? "";
      }
    });

    const response = await page.goto(allowed.url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });

    if (blockedMainError) return { ok: false, error: blockedMainError };

    let redirects = 0;
    let hop = response?.request().redirectedFrom() ?? null;
    while (hop) {
      redirects += 1;
      if (redirects > options.maxRedirects) return { ok: false, error: "Too many redirects" };
      const hopAllowed = await checkUrl(hop.url());
      if (!hopAllowed.ok) return hopAllowed;
      hop = hop.redirectedFrom();
    }

    const landed = await options.assertPublic(page.url());
    if (!landed.ok) return landed;

    const initialStatus = response?.status() ?? latestMainStatus ?? 200;
    const initialType = response?.headers()["content-type"] ?? latestMainContentType;

    if (response && initialStatus >= 200 && initialStatus < 300 && isBinaryContentType(initialType)) {
      const declared = Number(response.headers()["content-length"]);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        return { ok: false, error: "Response exceeds the size limit", status: initialStatus };
      }
      const body = await response.body();
      if (body.byteLength > options.maxBytes) {
        return { ok: false, error: "Response exceeds the size limit", status: initialStatus };
      }
      if (!body.byteLength) {
        return { ok: false, error: "Downloaded file is empty", status: initialStatus };
      }
      return {
        ok: true,
        bytes: new Uint8Array(body),
        contentType: initialType,
        finalUrl: landed.url,
        redirects,
        via: "browserbase",
      };
    }

    const settleMs = Math.min(4_000, Math.max(1_000, Math.floor(options.timeoutMs / 4)));
    await page.waitForLoadState("networkidle", { timeout: settleMs }).catch(() => undefined);
    await page.waitForTimeout(250);

    if (blockedMainError) return { ok: false, error: blockedMainError };
    const finalAllowed = await options.assertPublic(page.url());
    if (!finalAllowed.ok) return finalAllowed;

    const finalStatus = latestMainStatus ?? initialStatus;
    if (finalStatus < 200 || finalStatus >= 300) {
      return { ok: false, error: `HTTP ${finalStatus}`, status: finalStatus };
    }

    const html = await page.content();
    const bytes = new TextEncoder().encode(html);
    if (!bytes.byteLength) return { ok: false, error: "Downloaded file is empty", status: finalStatus };
    if (bytes.byteLength > options.maxBytes) {
      return { ok: false, error: "Response exceeds the size limit", status: finalStatus };
    }

    const shotBuffer = await page.screenshot({ type: "png", fullPage: false, timeout: 5_000 }).catch(() => undefined);
    const screenshot = shotBuffer && shotBuffer.byteLength > 0 && shotBuffer.byteLength <= options.maxBytes
      ? new Uint8Array(shotBuffer)
      : undefined;

    return {
      ok: true,
      bytes,
      contentType: latestMainContentType || initialType || "text/html; charset=utf-8",
      finalUrl: finalAllowed.url,
      redirects,
      via: "browserbase",
      ...(screenshot ? { screenshot } : {}),
    };
  } catch (error) {
    if (isTimeoutError(error)) return { ok: false, error: "Download timed out" };
    return { ok: false, error: "Download failed" };
  } finally {
    await browser?.close().catch(() => undefined);
    if (session) {
      await client.sessions
        .update(session.id, { status: "REQUEST_RELEASE", ...(projectId ? { projectId } : {}) })
        .catch(() => undefined);
    }
  }
}
