---
title: "Record why a source read failed in the production case log"
kind: gap
status: pending
created: 2026-11-07
summary: "A pipeline 3 proposal rejected as source_failed or source_uncertain has no cause in the case log: the failed source operation's error is kept only in the case_source_operations row, and neither the source_operation nor the proposal_rejected record carries it."
---

## Why
- `src/evidence/case-log.ts:24` builds `source_operation` records with operation, stage, status, recoveries and artifacts, but not `operation.error`, which `SourceService.stage` stores on fail (`src/instruction/sources.ts`, `operations.fail(..., reason, ...)`).
- `rejectionRecord` (`src/instruction/collection.ts`) writes only `reason: "source_failed"`; `fetchProposedUrls` keeps `errorCode` and drops the operation key.
- The 2026-11-07 at-185-ga eval rejected an X post (`x.com/Migraciones_AR/status/...`) as `source_failed` with no cause; production would show the same in the case log.

## What to do
Add the operation error to `source_operation` records (and/or link `proposal_rejected` to the failed operation key) so a failed read is explainable from the case log. Keep the error out of model-facing read results.

## Where
`src/evidence/case-log.ts`, `src/instruction/collection.ts`, `src/instruction/sources.ts` (read result / FetchedUrl), tests in `case-log.test.ts` and `collection.test.ts`.
