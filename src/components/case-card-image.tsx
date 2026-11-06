import { ModelMark, VerdictGlyph } from "./marks.tsx";
import { caseOutcome, contentOutcome, submissionExcerpt, VERDICT_LABEL } from "../domain/case.ts";
import { caseCardVotes } from "../domain/case-card.ts";
import { MODEL_NAME, type CaseRecord, type CaseView, type Verdict } from "../domain/court.ts";

const COLORS: Record<Verdict, string> = { verdadero: "#2f7a4b", falso: "#b3361f", no_verificable: "#e4c037", enganoso: "#e98939" };

// This square is used unchanged both on the home page and by social previews.
export function CaseCardImage({ c, view, image }: { c: CaseRecord; view: CaseView; image?: string }) {
  const votes = view.dismissal ? [] : caseCardVotes(view);
  const outcome = view.dismissal ? undefined : caseOutcome(view);
  const content = contentOutcome(view);
  const iconSize = Math.max(20, Math.min(42, Math.floor(400 / Math.max(votes.length, 1))));
  return (
    <div style={{ display: "flex", position: "relative", width: "100%", height: "100%", backgroundColor: "#e9e0cf", color: "#1b1915" }}>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" width={720} height={720} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <div style={{ display: "flex", padding: 55, fontSize: 32, color: "#57524a" }}>«{submissionExcerpt(c.submission).slice(0, 180)}»</div>
      )}
      <div style={{ display: "flex", position: "absolute", top: 24, left: 24, backgroundColor: "#f3ede1", ...(content ? { border: "2px solid #1b1915" } : {}), padding: "8px 14px", fontSize: content ? 26 : 19 }}>
        {content ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 32, backgroundColor: COLORS[content.verdict], color: content.verdict === "verdadero" || content.verdict === "falso" ? "white" : "#1b1915" }}>
              <VerdictGlyph verdict={content.verdict} style={{ width: 20, height: 20, ...(content.verdict === "falso" ? { transform: "rotate(180deg)" } : {}) }} />
            </div>
            {VERDICT_LABEL[content.verdict]}
          </div>
        ) : <>Nº {c.id}</>}
      </div>
      {(outcome || view.dismissal) && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", position: "absolute", right: 24, bottom: 24, gap: 6, backgroundColor: "#f3ede1", border: "2px solid #1b1915", padding: 12, boxShadow: "4px 4px 0 #1b1915" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 23 }}>
            {view.dismissal ? "Descartado" : content ? (votes.length === 1 ? "Afirmación: " : "Afirmaciones: ") + (outcome === "mixto" ? "Mixto" : outcome ? VERDICT_LABEL[outcome] : "") : outcome === "mixto" ? "Resultado mixto" : outcome && VERDICT_LABEL[outcome]}
          </div>
          {votes.map(({ id, verdict, models }) => (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {votes.length > 1 && <span style={{ fontSize: 17 }}>{id}</span>}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: iconSize, height: iconSize, borderRadius: iconSize, backgroundColor: COLORS[verdict], color: verdict === "verdadero" || verdict === "falso" ? "white" : "#1b1915" }}>
                <VerdictGlyph verdict={verdict} style={{ width: iconSize * 0.62, height: iconSize * 0.62, ...(verdict === "falso" ? { transform: "rotate(180deg)" } : {}) }} />
              </div>
              {models.map((model) => (
                <div key={model} title={MODEL_NAME[model]} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: iconSize, height: iconSize, borderRadius: iconSize, border: "1px solid #cfc4ae", color: "#1b1915" }}>
                  <ModelMark model={model} style={{ width: iconSize * 0.62, height: iconSize * 0.62 }} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
