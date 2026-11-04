"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteCaseButton({ caseId, active }: { caseId: string; active: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (!window.confirm(`¿Eliminar el caso Nº ${caseId} y sus archivos? Esta acción no se puede deshacer. El historial de ejecución del workflow no se elimina.`)) return;
    setPending(true);
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
      setPending(false);
    }
  }

  return (
    <div className="absolute right-3 top-3 z-10 flex max-w-[80%] flex-col items-end gap-1">
      <button type="button" onClick={remove} disabled={pending || active} aria-label={`Eliminar caso Nº ${caseId}`} title={active ? "No se puede eliminar un caso en curso" : "Eliminar caso"} className="grid size-9 place-items-center rounded-sm border border-rule bg-paper/95 text-ink shadow-sm hover:text-falso focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep disabled:cursor-not-allowed disabled:opacity-50">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-5">
          <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
        </svg>
      </button>
      {error && <p role="alert" className="rounded-sm bg-paper p-2 text-xs text-falso shadow-sm">{error}</p>}
    </div>
  );
}
