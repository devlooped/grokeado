---
title: "Mark cases failed when session opening fails"
kind: problem
status: pending
created: 2026-11-05
summary: "A pipeline preflight or other session-opening error occurs before the workflow's failure handler, leaving a newly queued case stuck as active."
---

## Why
`courtSession` awaits `openCase` before entering its `try` block (`src/workflows/court-session.ts`). `requestedPipeline` can throw during opening for invalid or missing configuration (`src/instruction/rollout.ts`), and `openSession` rolls back, so the case remains queued and cannot be retried or deleted through the UI.

## What to do
Handle opening failures by recording an appropriate failed status where possible, and add a regression test for preflight failure.

## Where
`src/workflows/court-session.ts`, `src/workflows/steps.ts`, and `src/workflows/court-session.test.ts`.
