import { readFileSync } from "node:fs";
import path from "node:path";
import { getCase, UPLOADS_DIR } from "@/store.ts";

export async function GET(_req: Request, ctx: RouteContext<"/caso/[id]/imagen">) {
  const { id } = await ctx.params;
  const c = getCase(id);
  if (c?.submission.kind !== "image") return new Response("No encontrada", { status: 404 });
  return new Response(readFileSync(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, c.submission.file)), {
    headers: { "content-type": c.submission.mimeType, "cache-control": "public, max-age=31536000, immutable" },
  });
}
