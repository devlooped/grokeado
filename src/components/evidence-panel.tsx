export function EvidencePanel({ caseId }: { caseId: string }) {
  return (
    <section className="mt-10">
      <div className="rule-double pt-4">
        <h2 className="font-display text-4xl">Expediente de evidencia</h2>
        <p className="mt-1 text-sm text-ink-soft">Descargá el expediente completo: archivos originales, extracciones, cronología, entidades y aportes de los analistas.</p>
      </div>
      <a
        className="btn-primary mt-5"
        href={`/c/${encodeURIComponent(caseId)}/file`}
      >
        Descargar expediente completo (ZIP)
      </a>
    </section>
  );
}
