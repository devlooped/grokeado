import { isAdmin, type CaseUser } from "./case-access.ts";

type StopCase = (id: string) => Promise<"stopped" | "missing" | "inactive" | "unavailable">;

export async function stopCaseResponse(request: Request, id: string, user: CaseUser | null | undefined, stop: StopCase): Promise<Response> {
  if (!user?.sub) return Response.json({ error: "Iniciá sesión." }, { status: 401 });
  if (!isAdmin(user)) return Response.json({ error: "No autorizado." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Origen no autorizado." }, { status: 403 });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return Response.json({ error: "Caso inválido." }, { status: 400 });
  try {
    const result = await stop(id);
    if (result === "missing") return Response.json({ error: "Caso no encontrado." }, { status: 404 });
    if (result === "inactive") return Response.json({ error: "El caso ya no está en curso. Actualizá la página." }, { status: 409 });
    if (result === "unavailable") return Response.json({ error: "No se encuentra la ejecución del caso. Si acaba de iniciarse, intentá de nuevo; las ejecuciones anteriores a esta función no se pueden detener desde aquí." }, { status: 409 });
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Case stop failed:", error);
    return Response.json({ error: "No se pudo detener el caso. Intentá de nuevo." }, { status: 500 });
  }
}
