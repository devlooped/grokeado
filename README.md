# Grokeado

The whole court runs as a Vercel Workflow. Each seat attempt is a durable step
using AI SDK through Vercel AI Gateway. Court events are saved to Postgres in
idempotent batches between rounds. Completed steps are replayed from the workflow
journal; an interrupted seat attempt can run again, including its paid model and
research calls.

The moderator and Grok analyst use `spacexai/grok-4.7`; the other analysts use
`google/gemini-4-argon`, `anthropic/claude-opus-5.5`, and `openai/gpt-5.5`.
`npm run models` lists the current Gateway catalog.

All analysts have Gateway's Parallel web search and Browserbase page fetch.
They can also search public X posts through a Grok researcher using Gateway and
the native X search tool. The moderator can fetch submitted links. Images are
loaded from Postgres and sent as image inputs. No Cursor account, local agent
process, provider API keys, or X OAuth connection is required.

## Court procedure

After the moderator identifies the claims, the court opens **instrucción**, a
stage exclusively for evidence. Every analyst must actively search for evidence
both supporting and opposing every claim, file relevant excerpts with their
orientation, and explicitly document both searches before finishing. Searches
that find no reliable evidence are recorded as such; analysts must not invent
evidence to create artificial balance.

The moderator then unifies contributions by source URL (ignoring `#` fragments).
Each shared source receives an `S` identifier and retains every original excerpt,
claim, orientation and contributing analyst. Original `P` contributions remain
in the audit trail. Distinct URLs remain separate sources.

All four analysts independently review every shared source, including their own,
and record a veto or a decision not to veto, with a concrete reliability reason.
**Three of the four analysts** must veto a source to exclude it; ties and absences
do not lower that threshold. The acta preserves all votes, reasons and excluded
sources. An unfinished moderator unification suspends the court after one retry.

Only after criticism ends does the court begin opening statements, rebuttals,
objections and final votes. Every seat sees the same closed source dossier and
may use any admitted source to support or challenge positions, regardless of who
contributed it. Statements can cite only admitted `S` identifiers. New evidence
cannot be filed during the debate; excluded sources cannot support statements,
votes or moderator decisions. If no evidence was found, the empty dossier is
recorded and analysts are instructed to vote `no_verificable` when evidence is
insufficient. Historical records without instruction events remain readable.

## Vercel setup

1. Select your team in the Vercel dashboard, open **AI Gateway → API Keys**, and
   create a key. Add `AI_GATEWAY_API_KEY` to `.env.local` (already git-ignored).
   Keep it server-side; do not prefix it with `NEXT_PUBLIC_`.
2. Check **AI Gateway → Credits** and add a payment method if requested. Gateway
   has its own usage balance, independent of a model vendor's chat subscription.
   Vercel documents a $5/month free tier with payment verification and purchased
   credits for larger workloads. Buying credits transitions the account to the
   paid tier, where the monthly free credit no longer applies. Model inference,
   web search, page fetch, and X research can all incur usage charges.
3. For deployment, keep your Postgres and Auth0 variables configured and either
   use Vercel's automatic OIDC Gateway authentication or add the Gateway key to
   the project's deployment environment variables. Redeploy after changes.
4. Under project **Settings → Environment Variables**, enable access to **System
   Environment Variables**. Workflow uses `VERCEL_DEPLOYMENT_ID` to select its
   managed Vercel backend. No hosted workflow service is needed for local tests.

References: [Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok),
[Gateway pricing](https://vercel.com/docs/ai-gateway/pricing),
[Gateway research tools](https://vercel.com/docs/ai-gateway/models-and-providers/web-search),
[Workflow deployment](https://workflow-sdk.dev/docs/deploying).

## Local development and live tests

Install dependencies with `npm install`. Merge the needed variables from
`.env.example` into your existing `.env.local`; do not overwrite existing secrets.
Use Node.js 22 or newer.

### Local AI Gateway simulation

Run `npm run dev:mock` to start Next.js with deterministic, fictitious AI
responses. Alternatively set `COURT_AI_MODE=mock` in `.env.local`, then restart
`npm run dev`. The default is `live`. This mode replaces both the Gateway models
and web/X research tools, so it makes no model, search or page-fetch requests and
does not need Gateway credentials. Postgres and Auth0 are still needed to use the
normal application UI; this mode only mocks AI and research.

The fixtures run through the real AI SDK tool loop, schemas, court procedure and
Workflow steps. They contribute sources both for and against the synthetic claim,
merge repeated sources with all four authors, and veto an unreliable source with
three votes. They also supply statements, an objection/reply/ruling and final
`no_verificable` votes. Source URLs use the reserved `.test` domain. The mock does
not analyze arbitrary claims or submitted images: all evidence and conclusions
are invented solely to exercise the application. Cases persist their simulation
flag so the acta and result remain visibly labeled even after switching modes.

To test individual mocked turns without a database, server or credentials:

```sh
node --import tsx --test src/court/mock.test.ts
```

These tests block network access and exercise turns independently; they do not
create or validate a complete case. To return to real providers, stop the mock
server, set `COURT_AI_MODE=live` (or remove it), and run `npm run dev`.

For a smaller live model test, run `npm run test:gateway`. It uses the actual
court prompts and tools to identify a census claim, research it with each of the
four analysts, unify and review the sources, and record their final votes. It requires a Gateway credential but
no database or web server. It makes paid requests and fails if any analyst
doesn't file evidence or vote. It does not test Workflow orchestration.

For a complete local scenario:

1. Set `AI_GATEWAY_API_KEY` and `DATABASE_URL` in `.env.local`.
2. Start the app with `npm run dev`. Restart it after changing credentials.
   Next.js runs the Workflow handlers locally and keeps the journal in
   `.next/workflow-data/`. Keep that folder to allow interrupted runs to resume.
3. In another terminal, run `npm run test:court`. This creates a case in the
   configured database and starts the compiled court workflow through the local
   server. It runs instruction, unification, source criticism, the full debate,
   objections, votes, and judgment, then checks
   that every analyst participated. It prints the case URL and workflow run ID.
   You can supply your own claim with `npm run test:court -- "Your claim here"`.
   The test expects a factual claim, so opinion-only submissions fail its
   evidence and voting assertions even if the court correctly dismisses them.
4. Alternatively, sign in through the UI and submit text, a link, or an image.
   UI login needs the Auth0 variables and a callback registered for the local
   `APP_BASE_URL`; the terminal test doesn't need a browser login.

`test:court` uses the same `.next/workflow-data/` directory as the local server; run
both from the project root. If using another port, set
`WORKFLOW_LOCAL_BASE_URL` for both processes. For CLI inspection, set
`WORKFLOW_LOCAL_DATA_DIR=.next/workflow-data` before running
`npx workflow inspect runs` or `npx workflow web`.

To check a completed run without creating another case, use
`npm run test:court -- --case <caseId> --run <workflowRunId>`. This checks the
record as it stands, including any historical absences. If overriding
`WORKFLOW_LOCAL_DATA_DIR`, use the same value for the server and test command.

Offline checks: `npm test`, `npm run typecheck`, and `npm run build`.
The separate [verification tier pilot](evals/tiers/README.md) runs three curated
cases through real Gateway research, medium moderation with substantive escalation,
bounded follow-up research and all four evaluators. It separates task complexity
from evidence sufficiency, with English identifiers and Spanish reports.
Use `npm run test:evals` for offline checks and `npm run eval:tiers`
for the paid experiment. It does not change production court behavior.
Each seat attempt has a 20-generation limit and a 270-second timeout (override
with `COURT_TURN_TIMEOUT_MS`). The court retries unfinished turns once; the
Workflow runtime also retries infrastructure failures. A running workflow can
outlast a single HTTP request, but an individual step is still bounded by the
hosting plan's function duration.
