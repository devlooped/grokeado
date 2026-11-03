export function EvidencePanel({ caseId }: { caseId: string }) {
  return (
    <section className="mt-10">
      <div className="rule-double pt-4">
        <h2 className="font-display text-4xl">Expediente de evidencia</h2>
        <p className="mt-1 text-sm text-ink-soft">Descargá el expediente completo: archivos originales, extracciones, cronología, entidades y aportes de los analistas.</p>
      </div>
      <a
        className="mt-5 inline-block rounded-sm bg-celeste-deep px-6 py-3 font-medium text-white shadow-[3px_3px_0_0_var(--color-ink)] transition hover:-translate-y-0.5 hover:bg-ink"
        href={`/caso/${encodeURIComponent(caseId)}/expediente`}
      >
        Descargar expediente completo (ZIP)
      </a>
    </section>
  );
}
