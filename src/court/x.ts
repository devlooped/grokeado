import type { SDKCustomTool, SDKCustomToolContent, SDKCustomToolResult, SDKJsonValue } from "@cursor/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

// Undocumented DashboardService RPCs: Cursor's backend runs the dashboard's X connector with
// the account's stored OAuth tokens. Only read tools are exposed; the connector can also post and send DMs.
const SERVER = "user-X";
const READ_TOOLS = [
  "search_posts_all",
  "get_posts_by_id",
  "get_posts_by_ids",
  "get_posts_quoted_posts",
  "get_users_by_username",
  "get_users_by_usernames",
  "get_users_posts",
  "search_news",
  "get_news",
];
const SESSION_MS = 30 * 60_000;

const listing = z.object({
  servers: z
    .array(
      z.object({
        serverIdentifier: z.string(),
        status: z.string(),
        tools: z.array(z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()).optional() })).optional(),
      })
    )
    .optional(),
});

const execution = z.object({
  result: z
    .looseObject({
      success: z
        .object({
          content: z
            .array(
              z.object({
                text: z.object({ text: z.string().default("") }).optional(),
                image: z.object({ data: z.string().default(""), mimeType: z.string().optional() }).optional(),
              })
            )
            .optional(),
          isError: z.boolean().optional(),
          structuredContent: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
});

let credentials: { apiKey: string; backend: string } | undefined;
let session: { token: string; expiresAt: number } | undefined;

function account() {
  if (credentials) return credentials;
  const file = path.join(homedir(), ".cursor", "sdk", "auth.json");
  const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { apiKey?: string; backendUrl?: string }) : {};
  const apiKey = process.env.CURSOR_API_KEY ?? stored.apiKey;
  if (!apiKey) throw new Error("falta la API key de Cursor (CURSOR_API_KEY o node scripts/login.mjs)");
  return (credentials = { apiKey, backend: (stored.backendUrl ?? "https://api2.cursor.sh").replace(/\/$/, "") });
}

async function accessToken(): Promise<string> {
  if (session && Date.now() < session.expiresAt) return session.token;
  const { apiKey, backend } = account();
  const res = await fetch(backend + "/auth/exchange_user_api_key", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error("no se pudo canjear la API key de Cursor (" + res.status + ")");
  const { accessToken } = z.object({ accessToken: z.string().min(1) }).parse(await res.json());
  session = { token: accessToken, expiresAt: Date.now() + SESSION_MS };
  return accessToken;
}

async function rpc(method: string, body: unknown): Promise<unknown> {
  const res = await fetch(account().backend + "/aiserver.v1.DashboardService/" + method, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + (await accessToken()), "x-ghost-mode": "true" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(method + " falló (" + res.status + "): " + text.slice(0, 200));
  return JSON.parse(text);
}

async function call(toolName: string, args: Record<string, SDKJsonValue>): Promise<SDKCustomToolResult> {
  const { result } = execution.parse(await rpc("ExecuteSandMcpTool", { serverIdentifier: SERVER, toolName, args, toolCallId: randomUUID() }));
  const success = result?.success;
  if (!success) return { content: [{ type: "text", text: "La herramienta de X falló: " + JSON.stringify(result ?? {}) }], isError: true };
  const content = (success.content ?? []).flatMap((c): SDKCustomToolContent[] => {
    if (c.text) return [{ type: "text", text: c.text.text }];
    if (c.image) return [{ type: "image", data: c.image.data, mimeType: c.image.mimeType }];
    return [];
  });
  if (!content.length && success.structuredContent) content.push({ type: "text", text: JSON.stringify(success.structuredContent) });
  return { content, isError: success.isError };
}

export async function openXTools(): Promise<Record<string, SDKCustomTool>> {
  const { servers = [] } = listing.parse(await rpc("ListSandMcpTools", { serverIdentifiers: [SERVER] }));
  const server = servers.find((s) => s.serverIdentifier === SERVER);
  if (server?.status !== "connected") throw new Error("la conexión X del dashboard no está disponible (" + (server?.status ?? "no existe") + ")");
  const prefix = SERVER + "-";
  const tools = (server.tools ?? []).filter((t) => t.name.startsWith(prefix) && READ_TOOLS.includes(t.name.slice(prefix.length)));
  return Object.fromEntries(
    tools.map((t): [string, SDKCustomTool] => [
      "x_" + t.name.slice(prefix.length),
      {
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as SDKCustomTool["inputSchema"],
        execute: (args) => call(t.name, args),
      },
    ])
  );
}
