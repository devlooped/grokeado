import { getImage } from "@/store.ts";

export async function GET(_req: Request, ctx: RouteContext<"/c/[id]/image">) {
  const { id } = await ctx.params;
  const image = await getImage(id);
  if (!image) return new Response("No encontrada", { status: 404 });
  return new Response(new Uint8Array(image.bytes), {
    headers: { "content-type": image.mimeType, "cache-control": "public, max-age=31536000, immutable" },
  });
}
