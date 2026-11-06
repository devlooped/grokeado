# Shared instruction and settled evidence (pipeline 2)

Pipeline 2 is the default for new cases, including production deployments from a
normal push. The user deferred the deployed smoke; live OIDC/egress and provider
cache/cost behavior have not been verified. Historical and in-flight
pipeline 1 cases keep their original tools, artifact formats, and download URLs;
[evidence.md](evidence.md) describes that legacy format.

## Boundaries

- The host owns acquisition, extraction/OCR, language verification and translation.
  Durable PostgreSQL operation claims deduplicate work within a case. Completed
  stages and confirmed failures are reused. An interrupted external operation
  becomes uncertain, never an automatic paid retry.
- Instruction and source criticism can discover sources. Criticism research must
  reference a unified `reviewSourceId`; its artifacts are `review_context`, not
  new claim filings. Intake translates the submission and its linked page, and
  court prompts and actions stay in the case language, but sources and discovery
  results are read in their original language until evidence closes: translating
  sources that may never be admitted spent the turns' time. Filed excerpts quote
  the original; seats translate what they quote in their own prose into the case
  language.
- Three or four vetoes exclude a source; zero through two admit it. Missing
  reviews are not vetoes. Closing instruction translates each admitted source
  wholesale into the case language, keeping its block IDs, then freezes admitted `E1.md` documents,
  their section mappings, `question.json`, `index.md` and a hash-verified manifest.
  Missing, partial or changed settled artifacts block debate.
- Debate starts clean once for each seat/channel, then appends committed events
  and messages. Private phase checkpoints retain tool-call outcomes and model
  steps for recovery, not for ZIP export. Sandbox preparation and host decisions
  are separate continuing conversations. Context overflow never resets history.
  Preparation reserves its eighth and last step for a response with tool calls
  disabled, also disabling tools when at most a minute remains in its
  300-second turn. Preparation sandboxes also have a 300-second timeout.
  Model/command timeouts respect the remaining turn time. It still fails closed
  if the budget expires without a nonempty final response; a partial draft cannot advance the decision
  channel. Exhaustion and incomplete final responses are non-retryable workflow
  failures: replaying an already spent checkpoint cannot replenish its budget.
- Debate tools read only manifest-listed IDs/sections, never URLs, originals or
  instruction drafts. All source-bearing court actions validate corpus citations.
  Local sandbox computation accepts bounded numeric operations, not shell code.

## Storage and downloads

New cases use `instruction/` for originals, canonical processing and provisional
research; immutable `evidence/` for admitted case-language sources; and
`discussion/` for later analytical drafts. The complete ZIP includes these
namespaces plus one root `case.jsonl`, a typed union of court events, model steps
and source-operation provenance. It omits a separate
`transcript.jsonl` and private conversation checkpoints.

The case record links admitted `E1` and `E1#p1:b2` references to safe Markdown previews.
Downloads remain public-read audit artifacts, **not a privacy boundary** and not
the input mounted into debate sandboxes. Legacy archives are not rewritten.

## Starting a case over

Only admins can retry failed cases or see raw failure details. Other visitors
receive a generic failure message with no retry control. The failed-case page's
**Reintentar** action and the admin rerun both perform a full reset before
starting a new workflow. They preserve the public case ID,
original submission/upload and access metadata, not generated processing state.
Events, covers, source operations/aliases, audit records, phase checkpoints,
sandbox bindings and Blob artifacts are removed; detected language and recorded
model/pipeline selections are cleared. The fresh preparation VM uses the current
configured snapshot rather than resuming any previous VM. Automatic retries of
a step within the same execution still reuse that execution's checkpoints.

## Local verification and recovery

Keep the effective `DATABASE_URL` restricted to explicit loopback and database
`grokeado_local_fixture`; `.env.local` is ignored and keeps the previous production
assignment commented locally. Never print connection strings or run the fixture
scripts against production. The scripts reject inherited remote URLs before
connecting:

```powershell
node --import tsx scripts/check-local-database.ts
node --import tsx scripts/test-local-instruction.ts
node --import tsx scripts/test-local-rerun.ts
$env:COURT_AI_MODE = "mock"
npm test
npm run typecheck
npm run build
git diff --check
```

The PostgreSQL fixture uses mocked acquisition/translation and in-memory
artifacts, verifies ownership/checkpoint CAS, ID regeneration and cascading
deletion, and cleans up its own case. It does not use Blob or paid AI.

For a failed or uncertain local source stage, inspect its operation and audit
first, then explicitly authorize only the affected stage:

```powershell
node --import tsx scripts/recover-source.ts --case CASE_ID --operation OPERATION_KEY --reason "Reviewed reason for retry"
```

This command is local-database guarded, records the reason, and does not execute
the retry. Exactly-once external billing cannot be guaranteed across a crash
between external completion and checkpoint publication.

## Deployment and deferred smoke

The normal deployment reuses existing configuration: the trusted HTTPS
`APP_BASE_URL` (or Vercel's `VERCEL_URL`), team/project identity from the host's
Vercel OIDC function context (or local `VERCEL_OIDC_TOKEN`),
`EVIDENCE_SANDBOX_SNAPSHOT_ID`, `AI_GATEWAY_API_KEY`, durable database and Blob
storage. The gateway key is shared with the rest of the application rather than
separately budgeted for evidence processing. Newly created
sandboxes receive the deployed instruction harness over the SDK; no separate
snapshot rebuild is needed for this code change. These harness files are included
in Next.js server traces. Resumed sandboxes retain their original harness.

Explicit `INSTRUCTION_TOOL_ORIGIN`, `INSTRUCTION_SANDBOX_TEAM_ID`,
`INSTRUCTION_SANDBOX_PROJECT_ID` and `INSTRUCTION_SANDBOX_SNAPSHOT_ID` overrides
remain available. Missing trusted identity, HTTPS origin, snapshot, storage or
gateway credentials fails before research; there is no open-network fallback.
No case allowlist, preview-only restriction or opt-in variable is required.
`COURT_PIPELINE_VERSION=1` rolls new cases back to the legacy pipeline; unset or
`2` selects shared instruction. Persisted cases retain their chosen version.

For a future deployed smoke, use explicitly authorized fixture storage and AI
costs. Do not point local verification at production or create snapshots without
authorization. Plan completion records implementation, not a passed live smoke.

Persistent sandboxes resume by name. Their OIDC-verified `sandboxName` selects
the binding, not the VM `sandboxId`, which can change across resumes.
Each stop snapshots the VM for the next turn; only the latest snapshot is kept
(24 h expiry), and the case's sandboxes are deleted with their snapshots when
the case resolves or fails. Evidence-step sandboxes are not persistent.
The SDK-authenticated proxy checks team/project, sandbox/case/session binding,
committed phase, active turn, expiry and request budget. Only exact POST tool and
generation paths are forwarded. Generation is constrained to the snapshotted
model/options and harness function tools; native search, URL/file inputs and
unmatched routes fail closed. No database, Blob or gateway credential enters the
VM. Deployed OIDC, deployment protection and egress must still be smoke-tested.
The SDK also serializes its user-agent into the generation body; the broker
accepts only that metadata, not arbitrary header overrides. Rejections log known
reason codes on the host while public errors remain generic. Preparation errors
include the command exit code, never raw sandbox output.

OpenAI requests use case/phase/seat/channel-scoped cache keys. Anthropic requests
mark the immutable initial message with an ephemeral cache breakpoint; other
providers retain their implicit caching behavior. Both channels record actual
provider usage, including cache-read/write fields when supplied. Stable prefixes
and hints do **not** prove cache hits: measure per-provider staging requests,
minimum lengths, TTLs and cost against the legacy fixture in the deferred smoke.
