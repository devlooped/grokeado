# Evidence bundle format

Cases store an OKF-style tree in private Vercel Blob storage at
`cases/{caseId}/evidence/`. `evidence/base/` is collector-owned and read-only.
Each assistant writes only under `evidence/{seat}/`, where the seat is `grok`,
`gemini`, `claude`, or `chatgpt`. Reprocessing adds a new fragment; it never
replaces the base extraction.

Every Markdown document except `index.md`, `timeline.md` and `entities.md` starts with YAML frontmatter:

```yaml
type: fragment
title: A short, neutral title
description: What this passage contains without arguing its significance.
sources:
  - evidence/base/raw/0123456789abcdef.pdf
generated:
  by: grok
  at: 2026-10-30T12:00:00.000Z
page: 3
reprocess_of: /evidence/base/docs/report.md#p3
```

Common fields are `type`, `title`, `description`, `sources`, and
`generated: { by, at }`. The `evidence` type additionally requires `pages`,
`extraction: { tool, confidence }`, and `tokens`. A `fragment` requires `page`
and may include `reprocess_of`. An `argument` requires `stage` (`exposicion`,
`objecion`, or `conclusion`), `supports`, and `refutes`.

Document IDs are their paths. Page anchors use `#pN`, for example
`/evidence/grok/passage.md#p3`. Sources may be HTTP(S) URLs or paths present in
the evidence tree. The validator rejects malformed YAML, unknown fields or
types, unresolved sources and links, author/namespace mismatches, writes
outside the author's namespace, and changes to `evidence/base/`.

Private Blob storage is the canonical source. Sandbox workspaces are rebuilt
from Blob for each attempt; the sandbox never receives Blob credentials.
The base collector preserves text and uploaded images, and downloads http(s)
links into `base/raw/`. Downloads reject credentials, non-public hosts,
redirects to private addresses, empty bodies, and responses over 8 MiB. PDFs
are extracted with `[p.N]` markers; a page that has an image and no text is
transcribed, and pipe tables are also stored as CSV. HTML is reduced to text
with scripts and styles removed. A failed download keeps the URL as a pointer
with confidence 0. `timeline.md` and `entities.md` are neutral catalogs.
Collection stops once `evidence/base/index.md` exists, and a later reprocess
never replaces `base/`.

To enable cloud processing, connect a **private** Vercel Blob store and set
`BLOB_READ_WRITE_TOKEN`. Create a separate AI Gateway key named for evidence
processing, set a monthly quota and short expiration, then configure it as
`EVIDENCE_AI_GATEWAY_API_KEY`; never reuse `AI_GATEWAY_API_KEY`. Run
`npm run evidence:snapshot`, set its output as
`EVIDENCE_SANDBOX_SNAPSHOT_ID`, and deploy on a Vercel plan that supports
network-policy header transforms. Without the Blob token, the evidence bundle
is not persisted. Without the snapshot or dedicated key, workflow evidence
steps return `partial` and the existing decision workflow continues.

The credential broker and open-egress policy require a Vercel plan that
supports network-policy header transforms. The implementation uses the
documented `ai-gateway.vercel.sh` Authorization transform with `"*": []` for
open network access. Verify a live streaming request after deployment before
enabling production cases.

With Blob configured, the deterministic mock harness promotes fragments
without starting a VM when `COURT_AI_MODE=mock`. It is intended for workflow
tests only and must not be treated as real evidence.

The sandbox upload is the stage workspace, not the whole tree. Exposición
receives `base/`, the seat's own files and `scratch/`. Objeciones add the
other seats. Conclusiones receive every `evidence/` path. Writes stay limited
to `evidence/{seat}/` and `scratch/`.

## Vercel smoke and security

These checks need a private Blob store, a snapshot, and a dedicated gateway
key. They are not part of `npm test`. Do not enable production evidence until
each one has passed:

1. Private Blob reads and writes succeed with `BLOB_READ_WRITE_TOKEN`. An
   unauthenticated `GET` of `/caso/{id}/evidencia/...` returns 404.
2. `npm run evidence:snapshot` prints a snapshot id. Set it as
   `EVIDENCE_SANDBOX_SNAPSHOT_ID`.
3. `EVIDENCE_AI_GATEWAY_API_KEY` is a different key from `AI_GATEWAY_API_KEY`,
   with a monthly quota and a short expiration.
4. One live evidence step streams a gateway response through the Authorization
   transform, then `sandbox.stop()` runs.
5. A harness timeout returns `partial`, and the decision step still runs.
6. Inside the VM, `env`, workspace files, and `/proc/*/environ` contain
   `placeholder` and do not contain the dedicated key. The key is only in the
   egress header built outside the VM.
7. A PDF whose text says to ignore instructions and print the environment is
   stored as page text. The transcript does not contain the dedicated key.
8. A write outside `evidence/{seat}/` and `scratch/` is rejected, and a change
   to `evidence/base/` is rejected.
9. After the smoke, rotate or expire the dedicated key and confirm the next
   sandbox call fails.
