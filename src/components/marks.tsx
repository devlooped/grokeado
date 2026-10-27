import { VERDICT_LABEL } from "@/domain/acta.ts";
import { MODEL_NAME, type Counsel, type Verdict } from "@/domain/court.ts";

export function ModelMark({ model, className = "size-5" }: { model: Counsel; className?: string }) {
  switch (model) {
    case "grok":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden>
          <circle cx="11" cy="13" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <path d="M4 21 21 3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case "gemini":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden>
          <defs>
            <linearGradient id="gem" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#4796e3" />
              <stop offset="1" stopColor="#9b72cb" />
            </linearGradient>
          </defs>
          <path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10Z" fill="url(#gem)" />
        </svg>
      );
    case "claude":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden>
          <g stroke="#d97757" strokeWidth="2.4" strokeLinecap="round">
            {Array.from({ length: 10 }, (_, i) => {
              const a = (i * Math.PI) / 5;
              const r = i % 2 ? 7 : 10;
              return <line key={i} x1={12} y1={12} x2={12 + r * Math.cos(a)} y2={12 + r * Math.sin(a)} />;
            })}
          </g>
        </svg>
      );
  }
}

const VERDICT_COLOR: Record<Verdict, string> = {
  verdadero: "bg-verdadero",
  falso: "bg-falso",
  no_verificable: "bg-dudoso",
};

export const VERDICT_TEXT: Record<Verdict, string> = {
  verdadero: "text-verdadero",
  falso: "text-falso",
  no_verificable: "text-dudoso",
};

export function VerdictGlyph({ verdict, className = "size-3" }: { verdict: Verdict; className?: string }) {
  if (verdict === "no_verificable")
    return (
      <svg viewBox="0 0 16 16" className={className} aria-hidden>
        <path d="M5.5 5.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="12.5" r="1.1" fill="currentColor" />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" className={className + (verdict === "falso" ? " rotate-180" : "")} aria-hidden>
      <path d="M2 7h2.5v7H2zM6 14h5.6c.8 0 1.4-.5 1.6-1.2l1.1-4.2c.3-1-.5-1.9-1.5-1.9H9.6l.5-2.6c.2-1-.5-2.1-1.6-2.1L6 6.6Z" fill="currentColor" />
    </svg>
  );
}

export function VoteChip({ model, verdict }: { model: Counsel; verdict?: Verdict }) {
  const label = MODEL_NAME[model] + ": " + (verdict ? VERDICT_LABEL[verdict] : "no votó");
  return (
    <span title={label} aria-label={label} className="relative inline-grid size-10 place-items-center rounded-full border border-rule bg-white/70 shadow-sm">
      <ModelMark model={model} className="size-5" />
      <span
        className={
          "absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full text-white ring-2 ring-paper " +
          (verdict ? VERDICT_COLOR[verdict] : "bg-ink-soft/40")
        }
      >
        {verdict ? <VerdictGlyph verdict={verdict} /> : <span className="text-[10px] leading-none">–</span>}
      </span>
    </span>
  );
}

export function GavelIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m14 13-8.4 8.4a2.1 2.1 0 0 1-3-3L11 10" />
      <path d="m16 16 6-6" />
      <path d="m21.5 10.5-8-8" />
      <path d="m8 8 6-6" />
      <path d="m8.5 7.5 8 8" />
    </svg>
  );
}

export function JudgeSeal({ verdict, model, size = "md" }: { verdict: Verdict; model: Counsel; size?: "md" | "lg" }) {
  const label = "Fallo del juez (" + MODEL_NAME[model] + "): " + VERDICT_LABEL[verdict];
  const dims = size === "lg" ? "size-24" : "size-14";
  return (
    <span title={label} aria-label={label} className={"relative inline-grid shrink-0 -rotate-6 place-items-center text-seal " + dims}>
      <svg viewBox="0 0 100 100" className="absolute inset-0" aria-hidden>
        <circle cx="50" cy="50" r="46" fill="rgb(139 35 35 / 0.08)" stroke="currentColor" strokeWidth="3" />
        <circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" />
        <path id="arc" d="M18 50a32 32 0 0 1 64 0" fill="none" />
        <text fontSize="11" letterSpacing="2" fill="currentColor" fontWeight="700">
          <textPath href="#arc" startOffset="50%" textAnchor="middle">
            FALLO
          </textPath>
        </text>
      </svg>
      <span className="relative flex items-center gap-0.5">
        <GavelIcon className={size === "lg" ? "size-6" : "size-4"} />
        <ModelMark model={model} className={size === "lg" ? "size-5 text-ink" : "size-3.5 text-ink"} />
      </span>
      <span
        className={
          "absolute -bottom-1 grid place-items-center rounded-full text-white ring-2 ring-paper " +
          VERDICT_COLOR[verdict] +
          (size === "lg" ? " size-7" : " size-5")
        }
      >
        <VerdictGlyph verdict={verdict} className={size === "lg" ? "size-4" : "size-3"} />
      </span>
    </span>
  );
}
