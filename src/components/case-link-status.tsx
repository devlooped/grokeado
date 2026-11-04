"use client";

import { useLinkStatus } from "next/link";
import { createPortal } from "react-dom";

export function CaseLinkStatus() {
  const { pending } = useLinkStatus();
  // Render outside animated and clipped cards so the fixed hint stays in the viewport.
  return pending && typeof document !== "undefined"
    ? createPortal(<span role="status" className="navigation-hint">Abriendo caso…</span>, document.body)
    : null;
}
