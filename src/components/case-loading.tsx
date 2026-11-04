export default function CaseLoading() {
  return (
    <div className="case-enter">
      <div role="status" className="pt-4">
        <p className="font-mono text-xs uppercase tracking-widest text-ink-soft">Cargando caso…</p>
        <div aria-hidden className="case-loading mt-4 space-y-6">
          <div className="h-12 w-48 max-w-full rounded-sm bg-paper-deep" />
          <div className="h-36 rounded-sm border border-rule bg-paper-deep" />
          <div className="space-y-3 border-b border-rule pb-6">
            <div className="h-5 w-3/4 rounded-sm bg-paper-deep" />
            <div className="h-5 w-1/2 rounded-sm bg-paper-deep" />
          </div>
        </div>
      </div>
    </div>
  );
}
