"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteCaseButton({ caseId, active }: { caseId: string; active: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<"delete" | "rerun" | null>(null);
  const [error, setError] = useState("");

  async function remove() {
    if (!window.confirm(`¿Eliminar el caso Nº ${caseId} y sus archivos? Esta acción no se puede deshacer. El historial de ejecución del workflow no se elimina.`)) return;
    setPending("delete");
    setError("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : "No se pudo eliminar el caso.");
      }
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "No se pudo eliminar el caso.");
    } finally {
      setPending(null);
    }
  }

  async function rerun() {
    if (!window.confirm(`¿Volver a ejecutar el caso Nº ${caseId}? Se creará un caso nuevo y el original se conservará. Esto puede generar costos.`)) return;
    setPending("rerun");
    setError("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/rerun`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.id !== "string") throw new Error(typeof body.error === "string" ? body.error : "No se pudo volver a ejecutar el caso.");
      router.push("/c/" + encodeURIComponent(body.id));
    } catch (error) {
      setError(error instanceof Error ? error.message : "No se pudo volver a ejecutar el caso.");
      setPending(null);
    }
  }

  const buttonClass = "grid size-9 cursor-pointer place-items-center rounded-sm border border-rule bg-paper/95 text-ink shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div className="absolute right-3 top-3 z-10 flex max-w-[80%] flex-col items-end gap-1">
      <div className="flex gap-1">
        <button type="button" onClick={rerun} disabled={!!pending || active} aria-label={`Volver a ejecutar caso Nº ${caseId}`} title={active ? "No se puede volver a ejecutar un caso en curso" : "Volver a ejecutar caso"} className={buttonClass + " hover:text-celeste-deep"}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-5">
            <path d="M20 11a8 8 0 0 0-14-5L4 8m0-4v4h4M4 13a8 8 0 0 0 14 5l2-2m0 4v-4h-4" />
          </svg>
        </button>
        <button type="button" onClick={remove} disabled={!!pending || active} aria-label={`Eliminar caso Nº ${caseId}`} title={active ? "No se puede eliminar un caso en curso" : "Eliminar caso"} className={buttonClass + " hover:text-falso"}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-5">
            <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
          </svg>
        </button>
      </div>
      {error && <p role="alert" className="rounded-sm bg-paper p-2 text-xs text-falso shadow-sm">{error}</p>}
    </div>
  );
}
