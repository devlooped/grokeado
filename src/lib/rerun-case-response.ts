import type { CaseRecord, Submission } from "../domain/court.ts";
import { isAdmin, type CaseUser } from "./case-access.ts";

type RerunDependencies = {
  getCase: (id: string) => Promise<CaseRecord | undefined>;
  getImage: (id: string) => Promise<{ bytes: Buffer } | undefined>;
  createCase: (submission: Submission, image: Buffer | undefined, ownerId: string) => Promise<string>;
  start: (id: string) => Promise<unknown>;
  finish: (id: string, status: "failed", error: string) => Promise<void>;
};

// A fresh case avoids reusing the old pipeline, model snapshot, events or artifacts.
export async function rerunCaseResponse(request: Request, id: string, user: CaseUser | null | undefined, deps: RerunDependencies): Promise<Response> {
  if (!user?.sub) return Response.json({ error: "Iniciá sesión." }, { status: 401 });
  if (!isAdmin(user)) return Response.json({ error: "No autorizado." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Origen no autorizado." }, { status: 403 });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return Response.json({ error: "Caso inválido." }, { status: 400 });
  try {
    const original = await deps.getCase(id);
    if (!original) return Response.json({ error: "Caso no encontrado." }, { status: 404 });
    if (original.status !== "resolved" && original.status !== "failed") return Response.json({ error: "No se puede volver a ejecutar un caso en curso." }, { status: 409 });
    const image = original.submission.kind === "image" ? await deps.getImage(id) : undefined;
    if (original.submission.kind === "image" && !image) return Response.json({ error: "No se encontró la imagen original." }, { status: 409 });
    const { resolvedLanguage: _resolvedLanguage, ...submission } = original.submission;
    const newId = await deps.createCase(submission, image?.bytes, user.sub);
    try {
      await deps.start(newId);
    } catch (error) {
      console.error("could not start court session:", error);
      await deps.finish(newId, "failed", "No se pudo iniciar la sesión.");
    }
    return Response.json({ id: newId }, { status: 201 });
  } catch (error) {
    console.error("Case rerun failed:", error);
    return Response.json({ error: "No se pudo volver a ejecutar el caso." }, { status: 500 });
  }
}
