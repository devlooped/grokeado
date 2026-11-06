"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function watchCaseUpdates(caseId: string, version: string, refresh: () => void): () => void {
  let current = version;
  let closed = false;
  let source: EventSource;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const close = () => { closed = true; clearTimeout(retry); source.close(); };
  const connect = () => {
    const connection = new EventSource(`/api/cases/${encodeURIComponent(caseId)}/events?since=${encodeURIComponent(current)}`);
    source = connection;
    connection.addEventListener("case-update", (event) => {
      if (closed || source !== connection) return;
      let update: { version: string; done: boolean };
      try {
        update = JSON.parse((event as MessageEvent<string>).data);
        if (typeof update?.version !== "string" || typeof update?.done !== "boolean") return;
      } catch { return; }
      if (update.done) close();
      if (update.version !== current || update.done) {
        current = update.version;
        refresh();
      }
    });
    // EOF/network reconnects are native. HTTP failures can leave EventSource
    // permanently closed; retry those too, using the last cursor we received.
    connection.onerror = () => {
      if (!closed && source === connection && connection.readyState === EventSource.CLOSED && retry === undefined) {
        retry = setTimeout(() => { retry = undefined; connect(); }, 1000);
      }
    };
  };
  connect();
  return close;
}

export function CaseUpdates({ caseId, version }: { caseId: string; version: string }) {
  const router = useRouter();
  useEffect(() => watchCaseUpdates(caseId, version, () => router.refresh()), [caseId, version, router]);
  return null;
}
