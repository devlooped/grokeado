import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto max-w-2xl py-16 text-center">
      <p className="font-mono text-xs uppercase tracking-widest text-ink-soft">404</p>
      <h1 className="mt-2 font-display text-5xl">Página no encontrada</h1>
      <p className="mx-auto mt-4 max-w-md text-ink-soft">No encontramos la página que buscás.</p>
      <Link href="/" className="mt-6 inline-block rounded-sm bg-ink px-6 py-3 font-medium text-paper hover:bg-celeste-deep">
        Volver al inicio
      </Link>
    </section>
  );
}
