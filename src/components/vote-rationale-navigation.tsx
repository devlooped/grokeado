"use client";

import { useEffect } from "react";

// Opens the folded reasons a link points to: one analyst's reason (#voto-…) or all the
// reasons of a claim (#fundamentos-…), which scroll to the claim itself.
export function VoteRationaleNavigation() {
  useEffect(() => {
    function reveal(hash: string, scroll: boolean) {
      const all = hash.startsWith("#fundamentos-");
      if (!all && !hash.startsWith("#voto-")) return;
      const target = document.getElementById(hash.slice(1));
      const details = target?.closest("details");
      if (!details) return;
      const wasOpen = details.open;
      details.open = true;
      if (all) (details.closest("article") ?? details).scrollIntoView();
      else if (scroll && !wasOpen) target?.scrollIntoView();
    }
    const onHashChange = () => reveal(window.location.hash, true);
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#voto-"], a[href^="#fundamentos-"]') : null;
      const href = link?.getAttribute("href") ?? "";
      const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
      if (href.startsWith("#fundamentos-") && plain) {
        event.preventDefault();
        if (window.location.hash !== href) history.pushState(null, "", href);
        reveal(href, true);
      } else if (link) reveal(href, false);
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
