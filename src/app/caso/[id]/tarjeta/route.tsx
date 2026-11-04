import { ImageResponse } from "next/og";
import { CaseCardImage } from "@/components/case-card-image.tsx";
import { project } from "@/domain/court.ts";
import { caseCardImageData, caseCardJpeg } from "@/lib/case-card-image.ts";
import { getCase, getCover, getEvents, getImage } from "@/store.ts";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const c = await getCase(id);
  if (!c || c.status !== "resolved") return new Response("No encontrada", { status: 404 });
  const [events, image] = await Promise.all([
    getEvents(id),
    c.submission.kind === "image" ? getImage(id) : getCover(id),
  ]);
  let src: string | undefined;
  if (image) {
    try {
      src = await caseCardImageData(image);
    } catch (error) {
      console.warn("Could not render cover for case " + id, error);
    }
  }
  const png = new ImageResponse(<CaseCardImage c={c} view={project(events)} image={src} />, { width: 720, height: 720 });
  const jpeg = await caseCardJpeg(await png.arrayBuffer());
  return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
}
