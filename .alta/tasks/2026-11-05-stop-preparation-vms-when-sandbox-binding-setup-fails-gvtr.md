---
title: "Stop preparation VMs when sandbox binding setup fails"
kind: problem
status: pending
created: 2026-11-05
summary: "Preparation acquires or resumes a sandbox and saves its binding before entering the cleanup try/finally. A binding failure can leave the VM running; the live case’s original intake sandbox was observed running after the binding errors."
---

## Why

`prepareInSandbox` acquires/resumes a VM and calls `deps.bind` before its `try/finally` begins (`src/instruction/preparation.ts`, lines 24–35). If binding setup throws, the code never suspends the active turn or calls `sandbox.stop`. Read-only Vercel metadata for `AT-185-GA` showed the original intake VM running after repeated binding failures.

Fresh case reruns now discard the old application checkpoints and bindings instead of trying to restore them. This proposal addresses the separate VM-lifecycle cleanup gap without weakening revocation or changing rerun semantics.

## What to do

Ensure every VM acquired by preparation is stopped when binding/setup fails, and suspend the active-turn grant before stopping it. Do not resume or stop a VM belonging to another case/session. Add regression tests for binding failures and checkpoint-save failures.

Do not mutate existing production sandboxes without authorization.

## Where

- `src/instruction/preparation.ts`
- `src/instruction/preparation.test.ts`
