"use client";

import { useActionState, useState } from "react";
import { requestFactCheck, type RequestState } from "@/app/actions.ts";

const KINDS = [
  { id: "text", label: "Texto" },
  { id: "link", label: "Enlace" },
  { id: "image", label: "Imagen" },
] as const;

type Kind = (typeof KINDS)[number]["id"];

const field = "w-full rounded-sm border border-rule bg-paper/80 px-4 py-3 text-base outline-none transition focus:border-celeste-deep focus:ring-2 focus:ring-celeste/30";

export function RequestForm({ signedIn }: { signedIn: boolean }) {
  const [kind, setKind] = useState<Kind>("text");
  const [state, action, pending] = useActionState<RequestState, FormData>(requestFactCheck, {});

  return (
    <form action={action} className="relative rounded-sm border border-ink/80 bg-paper p-5 shadow-[6px_6px_0_0_var(--color-ink)] sm:p-7">
      <input type="hidden" name="kind" value={kind} />
      <div className="flex items-end justify-between gap-4">
        <h2 className="font-display text-3xl leading-none">Pedí un chequeo</h2>
        <span className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">Formulario Nº 1</span>
      </div>

      <div role="tablist" aria-label="Tipo de material" className="mt-5 inline-flex rounded-sm border border-rule bg-paper-deep p-1">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={kind === k.id}
            onClick={() => setKind(k.id)}
            className={"rounded-sm px-4 py-1.5 text-sm font-medium transition " + (kind === k.id ? "bg-ink text-paper" : "text-ink-soft hover:text-ink")}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {kind === "text" && (
          <label className="block">
            <span className="sr-only">Texto a chequear</span>
            <textarea name="text" rows={6} required minLength={20} maxLength={6000} placeholder="Pegá acá la noticia, el posteo o la declaración que querés que chequeemos." className={field} />
          </label>
        )}
        {kind === "link" && (
          <>
            <label className="block">
              <span className="sr-only">Enlace</span>
              <input name="url" type="url" required placeholder="https://..." className={field} />
            </label>
            <label className="block">
              <span className="sr-only">Comentario</span>
              <input name="note" maxLength={500} placeholder="¿Qué parte te genera dudas? (opcional)" className={field} />
            </label>
          </>
        )}
        {kind === "image" && (
          <>
            <label className="block cursor-pointer rounded-sm border border-dashed border-ink-soft/60 bg-paper/50 px-4 py-6 text-center text-sm text-ink-soft hover:border-celeste-deep">
              <span className="block font-medium text-ink">Subí una captura o una imagen</span>
              <span className="block">PNG, JPG, WEBP o GIF, hasta 4 MB</span>
              <input name="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required className="mx-auto mt-3 block text-xs" />
            </label>
            <label className="block">
              <span className="sr-only">Comentario</span>
              <input name="note" maxLength={500} placeholder="¿Qué parte te genera dudas? (opcional)" className={field} />
            </label>
          </>
        )}
      </div>

      {state.error && (
        <p role="alert" className="mt-3 text-sm font-medium text-falso">
          {state.error}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-sm text-xs text-ink-soft">El análisis tarda unos minutos. Vas a poder seguir el estado en la página de tu caso.</p>
        {signedIn ? (
          <button
            type="submit"
            disabled={pending}
            className="rounded-sm bg-celeste-deep px-6 py-3 font-medium text-white shadow-[3px_3px_0_0_var(--color-ink)] transition hover:-translate-y-0.5 hover:bg-ink disabled:opacity-60"
          >
            {pending ? "Enviando…" : "Pedir el chequeo"}
          </button>
        ) : (
          <a
            href="/auth/login?returnTo=/"
            className="rounded-sm bg-celeste-deep px-6 py-3 font-medium text-white shadow-[3px_3px_0_0_var(--color-ink)] transition hover:-translate-y-0.5 hover:bg-ink"
          >
            Iniciá sesión para pedir el chequeo
          </a>
        )}
      </div>
    </form>
  );
}
