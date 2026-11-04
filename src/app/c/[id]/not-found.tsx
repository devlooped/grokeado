import Link from "next/link";

export default function CaseNotFound() {
  return (
    <section className="mx-auto max-w-2xl py-16 text-center">
      <p className="font-mono text-xs uppercase tracking-widest text-ink-soft">404</p>
      <h1 className="mt-2 font-display text-5xl">Caso no encontrado</h1>
      <p className="mx-auto mt-4 max-w-md text-ink-soft">No existe un caso registrado con ese identificador. Revisá que el enlace esté completo: los casos tienen la forma AB-123-CD.</p>
      <Link href="/" className="btn-primary mt-6">
        Volver al inicio
      </Link>
    </section>
  );
}
