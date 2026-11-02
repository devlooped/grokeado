import { retryCase } from "@/app/actions.ts";
import type { CaseRecord } from "@/domain/court.ts";
import { canRequestCase, type CaseUser } from "@/lib/case-access.ts";

export function Suspended({ c, user }: { c: CaseRecord; user: CaseUser | null | undefined }) {
  const canRetry = canRequestCase(user);
  return (
    <section className="mx-auto max-w-2xl py-16 text-center">
      <h1 className="font-display text-5xl">El análisis se interrumpió</h1>
      <p className="mx-auto mt-4 max-w-md text-ink-soft">El panel no pudo completar el análisis.{canRetry && " Podés volver a intentarlo."}</p>
      {c.error && <p className="mx-auto mt-3 max-w-md font-mono text-xs text-ink-soft">{c.error}</p>}
      {canRetry && (
        <form action={retryCase.bind(null, c.id)} className="mt-6">
          <button className="rounded-sm bg-ink px-6 py-3 font-medium text-paper hover:bg-celeste-deep">Reintentar</button>
        </form>
      )}
    </section>
  );
}
