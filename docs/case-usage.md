# Case usage and token costs

Every completed model step in a live case is stored in the durable case audit,
including support calls and completed steps before a later failure. Reusing a
checkpoint does not add usage; making another paid call does. The shared
pipeline records both sandbox preparation and decision calls. Legacy sandbox
preparation is read from the harness transcript, including rejected promotions.
Simulated calls are not billed or recorded as paid usage.

New case ZIP exports contain a root `case.json` alongside the existing logs.
Its `usage` array aggregates by the exact combination of:

- `provider`: the first segment of the Gateway model ID, e.g. `spacexai`, not `vercel`;
- `model`: the complete Gateway model ID;
- `effort`: the explicitly configured effort, or `null` when unknown;
- `role`: `moderator`, `analyst`, `translator`, `interpreter`, `captioner`, `x`,
  `coverSearch`, `coverReview`, `imagine`, or `evaluator`.

Each row contains `inputTokens`, `outputTokens`, cached read/write input counts,
`calls`, and `unknownUsageCalls`. Token totals include cached input and reasoning
output exactly once. Unknown totals are `null`, not zero. Only roles that
actually ran have rows; for example, the tier evaluator is not invoked by the
normal court pipeline. Language verification is counted as `interpreter`, using
the actual translator model that performs it.

The Panel's expanded **Cost** section shows an input/output chart and token/USD
table, pivoted by Provider, Model, or Role. It estimates the recorded token spend
using `vercel.models[modelId].cost` from `https://models.dev/api.json`, refreshed
hourly. Context tiers apply to each call individually. Cache read/write rates
are used when listed; otherwise the ordinary input rate applies. Pricing is
current list pricing, not a historical invoice or a billing API.

Missing models, prices, or usage remain visibly unpriced (`—` / `+ ?`) and are
excluded from the known subtotal. In particular, models.dev may not list token
prices for image generation. Search/tool fees and per-image fees are not token
costs and are not included. Historical cases have only the usage that was
recorded when they ran; existing ZIPs are not rewritten or backfilled. Failed
attempts retain their audit records, and a later successful export includes
their usage without freezing an immutable summary before the case finishes.
