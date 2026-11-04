import { getCover } from "@/store.ts";

export async function GET(req: Request, ctx: RouteContext<"/caso/[id]/portada">) {
  const { id } = await ctx.params;
  const cover = await getCover(id);
  if (!cover) return new Response("No encontrada", { status: 404 });
  // A versioned URL (?v=) never changes content, since a regenerated cover gets a new version.
  const versioned = new URL(req.url).searchParams.has("v");
  return new Response(new Uint8Array(cover.bytes), {
    headers: {
      "content-type": cover.mimeType,
      "x-content-type-options": "nosniff",
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=300",
    },
  });
}
