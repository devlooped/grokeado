"use client";

import { useId, useState } from "react";
import type { CaseCosts, CostPivot, CostRow } from "../domain/cost.ts";

const usd = (value: number) => "$" + value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
const count = (value: number | null) => value === null ? "—" : value.toLocaleString("es-AR");
const amount = (row: CostRow, key: "inputCost" | "outputCost" | "total") => row.pricedCalls ? usd(row[key]) + (row.unpricedCalls ? " + ?" : "") : "—";
const pivots: Record<CostPivot, string> = { provider: "Provider", model: "Model", role: "Role" };

export function CaseCost({ costs }: { costs?: CaseCosts }) {
  const [pivot, setPivot] = useState<CostPivot>("provider");
  const id = useId();
  const rows = costs?.rows[pivot] ?? [];
  const max = Math.max(...rows.map((row) => row.total), 0);
  return (
    <details open className="mt-4 border-t border-rule pt-3">
      <summary className="cursor-pointer text-xs text-celeste-deep hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celeste-deep">
        Cost{costs && costs.calls > costs.unpricedCalls ? ` · ${usd(costs.total)} USD${costs.unpricedCalls ? " + ?" : ""}` : ""}
      </summary>
      {!costs?.calls ? <p className="mt-3 text-xs text-ink-soft">Este caso no tiene uso de tokens registrado.</p> : (
        <>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs">
            <label htmlFor={id}>Agrupar por</label>
            <select id={id} value={pivot} onChange={(event) => setPivot(event.target.value as CostPivot)} className="rounded-sm border border-rule bg-paper px-2 py-1 text-ink">
              {Object.entries(pivots).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </div>
          <div role="img" aria-label={`Costo estimado en USD por ${pivots[pivot]}; desglose en la tabla`} className="mt-4 space-y-3">
            {rows.map((row) => (
              <div key={row.label}>
                <div className="mb-1 flex justify-between gap-2 text-[10px]"><span className="min-w-0 break-all">{row.label}</span><span className="shrink-0 font-mono">{amount(row, "total")}</span></div>
                <div className="flex h-2 overflow-hidden rounded-sm bg-paper-deep" aria-hidden>
                  <span className="bg-celeste-deep" style={{ width: `${max ? row.inputCost / max * 100 : 0}%` }} />
                  <span className="bg-seal" style={{ width: `${max ? row.outputCost / max * 100 : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 flex gap-3 text-[10px] text-ink-soft"><span><i className="mr-1 inline-block size-2 bg-celeste-deep" />Entrada</span><span><i className="mr-1 inline-block size-2 bg-seal" />Salida</span></p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-right font-mono text-[10px]">
              <caption className="sr-only">Costo estimado por {pivots[pivot]}, tokens y USD</caption>
              <thead><tr className="border-b border-rule"><th scope="col" className="py-2 text-left">{pivots[pivot]}</th><th scope="col" className="px-2">Tokens entrada</th><th scope="col" className="px-2">Tokens salida</th><th scope="col" className="px-2">USD entrada</th><th scope="col" className="px-2">USD salida</th><th scope="col">USD total</th></tr></thead>
              <tbody>{rows.map((row) => <tr key={row.label} className="border-b border-rule/50"><th scope="row" className="max-w-40 py-2 text-left break-all font-normal">{row.label}</th><td className="px-2">{count(row.inputTokens)}</td><td className="px-2">{count(row.outputTokens)}</td><td className="px-2 whitespace-nowrap">{amount(row, "inputCost")}</td><td className="px-2 whitespace-nowrap">{amount(row, "outputCost")}</td><td className="whitespace-nowrap">{amount(row, "total")}</td></tr>)}</tbody>
            </table>
          </div>
          {costs.unpricedCalls > 0 && <p role="status" className="mt-3 text-xs text-seal">{costs.unpricedCalls} llamadas sin precio o sin tokens informados; no se cuentan como gratuitas. «+ ?» indica un subtotal incompleto.</p>}
          <p className="mt-3 text-[10px] leading-relaxed text-ink-soft">Estimación del uso registrado, con las tarifas actuales en USD por millón de tokens de <a href="https://models.dev" target="_blank" rel="noreferrer noopener" className="underline">models.dev</a> para Vercel AI Gateway. Incluye caché y niveles de contexto cuando están informados. El proveedor es el prefijo del modelo. No incluye búsquedas, cargos por imagen ni otros cargos ajenos a tokens; no es una factura.</p>
        </>
      )}
    </details>
  );
}
