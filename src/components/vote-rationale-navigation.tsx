"use client";

import { useEffect } from "react";

export function VoteRationaleNavigation() {
  useEffect(() => {
    function reveal(hash: string, scroll: boolean) {
      if (!hash.startsWith("#voto-")) return;
      const target = document.getElementById(hash.slice(1));
      const details = target?.closest("details");
      if (details && !details.open) {
        details.open = true;
        if (scroll) target?.scrollIntoView();
      }
    }
    const onHashChange = () => reveal(window.location.hash, true);
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#voto-"]') : null;
      if (link) reveal(link.getAttribute("href") ?? "", false);
    };
    reveal(window.location.hash, true);
    window.addEventListener("hashchange", onHashChange);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return null;
}
