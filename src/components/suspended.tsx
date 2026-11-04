import Link from "next/link";
import { retryCase } from "@/app/actions.ts";
import type { CaseRecord } from "@/domain/court.ts";
import { canRequestCase, type CaseUser } from "@/lib/case-access.ts";

export function Suspended({ c, user }: { c: CaseRecord; user: CaseUser | null | undefined }) {
  const canRetry = canRequestCase(user);
  return (
    <section className="mx-auto max-w-2xl py-16 text-center">
      <h1 className="font-display text-5xl">El análisis se interrumpió</h1>
      <p className="mx-auto mt-4 max-w-md text-ink-soft">El panel no pudo completar el análisis.{canRetry && " Podés volver a intentarlo."}</p>
      {c.error && <p className="mx-auto mt-3 max-w-md font-mono text-xs text-ink-soft">Detalle: {c.error}</p>}
      {canRetry ? (
        <form action={retryCase.bind(null, c.id)} className="mt-6">
          <button className="btn-primary">Reintentar</button>
        </form>
      ) : (
        <p className="mx-auto mt-4 max-w-md text-sm text-ink-soft">
          Si necesitás este resultado, escribinos a{" "}
          <a href={"mailto:hola@che.bot?subject=" + encodeURIComponent("Caso " + c.id + " interrumpido")} className="font-medium text-celeste-deep underline">hola@che.bot</a>{" "}
          con el número de caso ({c.id}).
        </p>
      )}
      <p className="mt-6 text-sm">
        <Link href="/" className="text-celeste-deep underline decoration-celeste/40 underline-offset-4 hover:decoration-celeste-deep">← Volver a los casos</Link>
      </p>
    </section>
  );
}
