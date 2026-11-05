# Evidence bundle format

This page describes the legacy pipeline 1 bundle. New cases default to pipeline 2,
which uses [shared instruction and settled evidence](shared-instruction.md); existing
cases and archives retain the format below.

Cases store an OKF-style tree in public-read Vercel Blob storage at
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
  modelId: spacexai/grok-4.7
  effort: null
page: 3
reprocess_of: /evidence/base/docs/report.md#p3
```

Common fields are `type`, `title`, `description`, `sources`, and
`generated: { by, at }`. Promoted analyst documents also record the actual
`generated.modelId` and `generated.effort`; older documents may omit them.
The host stamps these fields rather than trusting the analyst. `effort: null`
means no explicit effort was configured (or, for historical records, it is
unknown); it does not assert a provider's default. Simulated documents use
`court-fixture` with null effort. The `evidence` type additionally requires `pages`,
`extraction: { tool, confidence }`, and `tokens`. A `fragment` requires `page`
and may include `reprocess_of`. An `argument` requires `stage` (`exposicion`,
`objecion`, or `conclusion`), `supports`, and `refutes`.

Document IDs are their paths. Page anchors use `#pN`, for example
`/evidence/grok/passage.md#p3`. Sources may be HTTP(S) URLs or paths present in
the evidence tree. The validator rejects malformed YAML, unknown fields or
types, unresolved sources and links, author/namespace mismatches, writes
outside the author's namespace, and changes to `evidence/base/`.

Public Blob storage is the canonical source. Objects are written with
`access: "public"` and stable pathnames, so anyone with the URL can read them.
When a case completes, the complete `evidence/` tree (including originals,
catalogs, extractions, analyst files, and run artifacts) is compressed and
stored separately at `cases/{caseId}/case.zip` before the case is marked
resolved. A storage error prevents the case from being marked resolved. The
ZIP includes every stored file under `evidence/`, including raw court research
tool calls and their complete returned results under
`evidence/{seat}/research/{runId}/` (including `judge` when applicable). These
JSON files are export artifacts, not promoted or citable sandbox evidence.
For new cases, each analyst's filed URLs are also downloaded under
`evidence/{seat}/downloads/{runId}/`. `source.json` records the URL, download or
extraction status, and paths to the unchanged original and extracted text.
When extraction succeeds, the text is translated into the case language if
needed and saved separately as `translated.txt`; otherwise the extracted text
remains unchanged. If translation fails, processing continues with the original
and extracted text retained; `source.json` records `translation_failed` and
the `translationError`, and no translation is written for that attempt.
Unsupported formats, inaccessible sources, and unsuccessful OCR are recorded
rather than presented as translations. Originals, raw research
responses, and audit transcripts are never replaced with translations. These
downloads are archive artifacts, not new citable evidence; the source itself
must still be checked. They use the existing public-URL and size checks.

The requested language is Detectar, Español, or Inglés. Automatic detection
uses the submitted text, extracted linked content, or the submitted image;
when no usable content is available it falls back to Spanish. Spanish means
Latin American Spanish. The resolved language is saved for retries. Analyst
filed titles and excerpts, including quotations, are translated before they enter
the record and are unified for source criticism. Their original text is retained
in the event record and can be inspected in the acta. Translation failure stops
the case instead of silently publishing an untranslated contribution. Each
instruction attempt also completes the archival download/translation described
above before source criticism begins; these downloads are not fed to the review.
Markdown documents downloaded from the sandbox are translated when necessary;
their originals are retained under the run's `originals/` directory. Model
translation can introduce errors and is not a substitute for the original.
Detection and translation make additional AI Gateway calls; an error translating
promoted analyst evidence fails the case rather than silently presenting
untranslated evidence. Downloaded archival source translation failures are
recorded as described above and do not themselves fail the case.
Mock mode uses
fixed Spanish fixtures and does not download analyst URLs or call translation.
Existing cases and archives are not retroactively translated.

Rebuild and configure the evidence sandbox snapshot using
`npm run evidence:snapshot` after deploying the updated harness; older snapshots still
contain the former Spanish-only instruction, although the promotion translation
step applies the case language after download.
The ZIP also contains `acta.jsonl`, the complete committed event record,
including evidence submissions, source reviews, objections, votes, and decisions.
The closing step also writes `cases/{caseId}/transcript.jsonl` and includes it at
the ZIP root. It merges sandbox evidence steps (tagged `evidence_step` with
`seat` and `runId`) and committed debate `statement` events in timestamp
order. Every entry has a `modelId` and an `effort`: the model and explicitly
configured effort used for that evidence step or statement. The sandbox harness
currently requests no explicit effort, independently of the court turn's
settings. Research step artifacts and session-opening events also record court
effort; statements retain the effort for their particular turn. Simulated
statements use `court-fixture` and null effort. For older records, the
stored session model is used when available; `modelId` is `null` when the
historical model is unknown rather than guessing from current configuration.
Historical effort is null unless recorded for that statement or its matching
session model. It is never inferred for a sandbox run from court settings.
Statements carry their original sequence and, when an evidence run was
promoted for that turn, its `evidenceRunId`; those statements are also appended
to that run's `evidence/{seat}/runs/{runId}/transcript.jsonl`. The export is
rebuilt on retries without duplicating statements. Statements without a
promoted run still appear in the case transcript. On first download, older cases
with stored base evidence get a new complete ZIP built from the available tree
and event record; their original ZIP is not overwritten. If the base is no
longer available, the original ZIP is offered as-is. Research tool results that
were never stored cannot be recovered, and historical statements cannot be
matched to runs without a recorded run ID.
The transcript, like the rest of the Blob store, is publicly readable.
The case page offers a single ZIP download; individual files remain available for
citations. Resolved cases created before ZIP export was introduced create and
store the archive on their first download, if their base evidence exists.
Research capture is limited to responses actually returned by the tools; it does
not reconstruct material the providers did not return. These responses and the
full event record are public, like the rest of the evidence store. Each research
step is subject to the 8 MiB per-file evidence limit; oversized results fail the
case rather than being silently truncated.
Sandbox workspaces are rebuilt
from Blob for each attempt; the sandbox never receives Blob credentials.
The base collector preserves text and uploaded images, and downloads http(s)
links into `base/raw/` using a two-tier pipeline: a fast Chrome TLS/HTTP2
impersonating fetch (`impit`) first, escalating automatically to a remote
stealth Chromium session (`Browserbase` + `playwright-core`) when `BROWSERBASE_API_KEY`
is configured and the direct fetch encounters anti-bot blocks, challenges, or
unrendered SPA shells. Every redirect hop and browser request is checked
against the public-address SSRF filter; downloads reject credentials,
non-public hosts, redirects to private addresses, empty bodies, and responses
over 8 MiB. PDFs are extracted with `[p.N]` markers; a page that has an image
and no text is transcribed, and pipe tables are also stored as CSV. HTML is
converted to clean Markdown with `defuddle` + `linkedom` (`useAsync: false`),
preserving tables as CSV and any Browserbase viewport screenshot in `base/raw/`,
with scripts and styles omitted. A failed download keeps the URL as a pointer
with confidence 0. `timeline.md` and `entities.md` are neutral catalogs.
Collection stops once `evidence/base/index.md` exists, and a later reprocess
never replaces `base/`. Extracted link/image text is also passed into the
court docket so intake and debate seats start with concrete material even when
Blob persistence is disabled.

To enable cloud processing, connect a **public** Vercel Blob store. Deployed
environments use `BLOB_READ_WRITE_TOKEN`. Local checks use a Vercel OIDC token
(`VERCEL_OIDC_TOKEN`) together with `BLOB_STORE_ID`. That token is
development-scoped, so the store's project connection must include
Development. Reads fetch the public
blob URL; one of those credentials is required to list and write. An overwrite
can stay on the CDN for up to 60 seconds, so server reads add the current etag
as a query parameter. Optionally set `BROWSERBASE_API_KEY` (and
`BROWSERBASE_PROJECT_ID` / `BROWSERBASE_PROXIES`) for stealth browser fallback
during link collection. Create a separate AI Gateway key named for evidence
processing, set a monthly quota and short expiration, then configure it as
`EVIDENCE_AI_GATEWAY_API_KEY`; never reuse `AI_GATEWAY_API_KEY`. Run
`npm run evidence:snapshot`, set its output as
`EVIDENCE_SANDBOX_SNAPSHOT_ID`, and deploy on a Vercel plan that supports
network-policy header transforms. Without blob credentials, the evidence bundle
is extracted in memory for court turns and not persisted, so no ZIP is available. Without the snapshot or dedicated key, workflow evidence
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

These checks need a public-read Blob store, a snapshot, and a dedicated gateway
key. They are not part of `npm test`. Do not enable production evidence until
each one has passed:

1. Public Blob reads and writes succeed. Locally, `npm run evidence:smoke`
   mints a Vercel OIDC token and uses `BLOB_STORE_ID`. The store connection
   must include Development, because the CLI issues a development token. A
   deployed environment may use `BLOB_READ_WRITE_TOKEN` instead. `put` uses
   `access: "public"`.
   Reads fetch the public blob URL with no token. An unauthenticated `GET` of
   `/c/{id}/evidence/...` returns the file when the case exists.
   After a case resolves, download `/c/{id}/file` and verify that the
   ZIP stored at `cases/{caseId}/case.zip` contains the complete tree.
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
