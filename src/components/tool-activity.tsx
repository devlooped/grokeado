import type { ToolActivity } from "@/domain/tool-activity.ts";

function ToolIcon({ tool }: { tool: ToolActivity["data"]["tool"] }) {
  if (tool === "x_search") return (
    <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0" fill="currentColor" aria-hidden>
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.49h2.039L6.487 3.24H4.3l13.31 17.403Z" />
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {tool === "read_source" ? <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>
        : tool === "read_evidence" ? <><ellipse cx="7" cy="12" rx="4.5" ry="7" /><ellipse cx="17" cy="12" rx="4.5" ry="7" /><circle cx="8" cy="12" r="1.5" fill="currentColor" /><circle cx="18" cy="12" r="1.5" fill="currentColor" /></>
          : <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>}
    </svg>
  );
}

export function ToolActivityEntry({ activity, caseId }: { activity: ToolActivity; caseId: string }) {
  const data = activity.data;
  return (
    <div data-tool={data.tool} className="flex items-start gap-2 text-sm text-ink-soft">
      <ToolIcon tool={data.tool} />
      <p className="min-w-0 flex-1 truncate" title={"query" in data ? data.query : data.tool === "read_evidence" ? `${data.id} · ${data.url}` : data.url}>
        {data.tool === "web_search" || data.tool === "x_search" ? data.query : (
          <>
            {data.tool === "read_evidence" && <><a href={`/c/${encodeURIComponent(caseId)}/evidence/${data.id}.md`} className="font-mono font-semibold text-celeste-deep underline">{data.id}</a>{" · "}</>}
            <a href={data.url} target="_blank" rel="noreferrer noopener" className="text-celeste-deep underline underline-offset-2">{data.url}</a>
          </>
        )}
      </p>
    </div>
  );
}
