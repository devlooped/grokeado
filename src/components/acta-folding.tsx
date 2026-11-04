"use client";

import { useEffect, useRef } from "react";

// The acta folds into stages, analyst groups and cards, all plain <details>. These
// controls open or close every fold of their scope: the whole acta, or one stage
// (whose own fold stays open when collapsing, so its structure shows).
export function FoldButtons({ label }: { label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  function fold(open: boolean) {
    const scope = ref.current?.closest("[data-fold-scope]");
    if (!scope) return;
    const own = scope.getAttribute("data-fold-scope") === "section" ? scope.querySelector<HTMLDetailsElement>(":scope > details") : null;
    for (const details of scope.querySelectorAll("details")) details.open = open || details === own;
  }
  const button = "grid size-7 place-items-center rounded-full border border-rule text-ink-soft transition hover:bg-paper-deep hover:text-ink";
  return (
    <div ref={ref} className="flex shrink-0 items-center gap-1.5">
      <button type="button" onClick={() => fold(true)} aria-label={"Expandir todo: " + label} title={"Expandir todo: " + label} className={button}>
        <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
        </svg>
      </button>
      <button type="button" onClick={() => fold(false)} aria-label={"Colapsar todo: " + label} title={"Colapsar todo: " + label} className={button}>
        <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m7 20 5-5 5 5M7 4l5 5 5-5" />
        </svg>
      </button>
    </div>
  );
}

// Opens the folds around the target of an in-page link (a citation, an intervention or an
// objection), so that following a link into a collapsed stage still shows it.
export function FoldNavigation() {
  useEffect(() => {
    function reveal(hash: string): boolean {
      if (hash.length < 2) return false;
      let id: string;
      try {
        id = decodeURIComponent(hash.slice(1));
      } catch {
        return false;
      }
      const target = document.getElementById(id);
      if (!target?.closest("[data-acta]")) return false;
      let hidden = false;
      for (let details: HTMLDetailsElement | null | undefined = target.closest("details"); details; details = details.parentElement?.closest("details")) {
        if (details.open) continue;
        details.open = true;
        hidden = true;
      }
      return hidden;
    }
    const onHashChange = () => {
      if (reveal(window.location.hash)) document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
    };
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
      if (link) reveal(link.getAttribute("href") ?? "");
    };
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return null;
}
