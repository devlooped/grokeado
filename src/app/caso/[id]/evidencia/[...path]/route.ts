import { auth0 } from "@/lib/auth0.ts";
import { readEvidenceTree } from "@/evidence/blob.ts";
import { renderEvidenceHtml } from "@/evidence/okf.ts";
import { getCase } from "@/store.ts";

const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(_request: Request, context: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path } = await context.params;
  const session = await auth0.getSession();
  const record = await getCase(id);
  if (!session?.user.sub || !record?.ownerId || session.user.sub !== record.ownerId) return new Response("No encontrada", { status: 404 });
  if (!path.length || path.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
    return new Response("No encontrada", { status: 404 });
  }

  const relativePath = `evidence/${path.join("/")}`;
  const file = (await readEvidenceTree(id)).get(relativePath);
  if (!file) return new Response("No encontrada", { status: 404 });
  const extension = relativePath.slice(relativePath.lastIndexOf(".")).toLowerCase();
  const markdown = extension === ".md";
  return new Response(markdown ? renderEvidenceHtml(new TextDecoder().decode(file)) : Buffer.from(file), {
    headers: {
      "content-type": markdown ? "text/html; charset=utf-8" : TYPES[extension] ?? "application/octet-stream",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
