import { setTimeout as delay } from "node:timers/promises";
import type { CaseProgress } from "../store.ts";

export const caseProgressVersion = (progress: CaseProgress) => `${progress.revision}:${progress.status}:${progress.seq}`;

type ReadProgress = (caseId: string) => Promise<CaseProgress | undefined>;

// SSE carries invalidations only. The existing server-rendered dialogue remains
// the sole renderer of public, complete messages, never model steps or traces.
export async function caseEventStream(request: Request, caseId: string, read: ReadProgress): Promise<Response> {
  let initial: CaseProgress | undefined;
  try {
    initial = await read(caseId);
  } catch {
    return Response.json({ error: "No se pudo consultar el progreso del caso." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!initial) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

  let previous = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("since");
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let lifetime: ReturnType<typeof setTimeout>;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => {
    closed = true;
    clearTimeout(lifetime);
    request.signal.removeEventListener("abort", close);
    abort.abort();
  };
  const close = () => {
    if (closed) return;
    cleanup();
    controller.close();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      controller = output;
      request.signal.addEventListener("abort", close, { once: true });
      // Rotate before a serverless execution limit; EventSource resumes by id.
      lifetime = setTimeout(close, 50_000);
      if (request.signal.aborted) { close(); return; }
      controller.enqueue(encoder.encode("retry: 1000\n\n"));
      void (async () => {
        let progress: CaseProgress | undefined = initial;
        let heartbeat = Date.now();
        while (!closed) {
          const version = progress ? caseProgressVersion(progress) : "missing";
          const done = !progress || progress.status === "resolved" || progress.status === "failed";
          if (version !== previous || done) {
            controller.enqueue(encoder.encode(`id: ${version}\nevent: case-update\ndata: ${JSON.stringify({ version, done })}\n\n`));
            previous = version;
            heartbeat = Date.now();
          } else if (Date.now() - heartbeat >= 15_000) {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            heartbeat = Date.now();
          }
          if (done) { close(); return; }
          // Short, pooled reads work with transaction poolers and across workers;
          // no dedicated PostgreSQL connection is held for an idle viewer.
          await delay(1000, undefined, { signal: abort.signal });
          if (closed) return;
          progress = await read(caseId);
        }
      })().catch(() => {
        // A clean EOF lets EventSource reconnect after transient storage errors.
        close();
      });
    },
    cancel() {
      if (!closed) cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
