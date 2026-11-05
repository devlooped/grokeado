"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteNotification } from "@/app/admin/actions.ts";
import { ADMIN_NOTIFICATIONS_CHANGED_EVENT } from "./user-claims-badge.tsx";

export function DeleteNotificationButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (!window.confirm(`¿Eliminar la notificación «${title}»? Esta acción no se puede deshacer.`)) return;
    setPending(true);
    setError("");
    try {
      await deleteNotification(id);
      router.refresh();
      window.dispatchEvent(new Event(ADMIN_NOTIFICATIONS_CHANGED_EVENT));
    } catch (error) {
      setError(error instanceof Error ? error.message : "No se pudo eliminar la notificación.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button type="button" onClick={remove} disabled={pending} aria-label={`Eliminar notificación: ${title}`} title="Eliminar notificación" className="grid size-9 place-items-center rounded-sm border border-rule bg-paper text-ink hover:text-falso focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep disabled:cursor-wait disabled:opacity-50">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-5">
          <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
        </svg>
      </button>
      {error && <p role="alert" className="max-w-48 rounded-sm bg-paper p-2 text-right text-xs text-falso shadow-sm">{error}</p>}
    </div>
  );
}
