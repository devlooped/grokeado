"use client";

import { useUser } from "@auth0/nextjs-auth0/client";
import { useEffect, useId, useRef, useState } from "react";

export function formatClaimValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "";
  return JSON.stringify(value);
}

export function extractClaimRows(claims: Record<string, unknown> | null | undefined): { key: string; value: string }[] {
  if (!claims) return [];
  const entries = Object.entries(claims).filter(([, value]) => value !== undefined);
  const priority = ["sub", "email", "email_verified", "roles"];
  entries.sort(([a], [b]) => {
    const ai = priority.indexOf(a);
    const bi = priority.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? priority.length : ai) - (bi === -1 ? priority.length : bi);
    return a.localeCompare(b);
  });
  return entries.map(([key, value]) => ({ key, value: formatClaimValue(value) }));
}

export function UserClaimsPopover({
  claims,
  open,
  onToggle,
}: {
  claims: Record<string, unknown>;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  const rows = extractClaimRows(claims);
  if (rows.length === 0) return null;

  return (
    <div className="relative normal-case tracking-normal">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Ver atributos de la sesión"
        title="Atributos del token de sesión"
        className={
          "grid size-8 shrink-0 place-items-center rounded-full border transition " +
          (open ? "border-celeste-deep bg-celeste/15 text-celeste-deep" : "border-rule text-celeste-deep hover:bg-paper-deep")
        }
      >
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Atributos del token"
          className="absolute right-0 z-50 mt-2 w-[min(28rem,calc(100vw-2.5rem))] rounded-sm border border-ink/80 bg-paper p-4 text-ink shadow-[6px_6px_0_0_var(--color-ink)]"
        >
          <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-2">
            <span className="font-display text-xl leading-none">Sesión activa</span>
            <a href="/auth/logout" className="text-xs text-ink-soft underline hover:text-celeste-deep">
              Cerrar sesión
            </a>
          </div>
          <div className="mt-3 max-h-80 overflow-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-rule font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Claim
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    Valor
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule/60 font-mono">
                {rows.map(({ key, value }) => (
                  <tr key={key} className="align-top">
                    <th scope="row" className="py-1.5 pr-3 font-medium break-all text-ink-soft">
                      {key}
                    </th>
                    <td className="py-1.5 break-all text-ink">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function UserClaimsBadge() {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div ref={containerRef}>
      <UserClaimsPopover claims={user} open={open} onToggle={() => setOpen((prev) => !prev)} />
    </div>
  );
}
