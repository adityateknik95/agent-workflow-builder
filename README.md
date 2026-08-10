# Agent Workflow Builder

**Live app:** <https://agent-workflow-builder-swart.vercel.app>
Sign in as `owner.a@example.com` / `Password123!` (see the table below for the
other roles and the second organisation).

A small multi-tenant workflow engine for chaining AI agent steps, built on nhost
(PostgreSQL + Hasura + Auth + Functions) with a Next.js front end.

Users belong to organisations. Inside an organisation they build workflows out of
ordered steps (`llm_call`, `http_request`, `db_write`, `notify`,
`conditional_branch`, `approval_gate`), attach triggers (manual, inbound webhook,
cron schedule, database event), run them, and watch each step's progress live over
a GraphQL subscription — including runs that stop half way and wait for a human to
approve them.

Every action is checked twice: once by Hasura row permissions scoped to the
caller's organisation, and again inside the Action handler for the things a row
rule cannot express.

---

## Contents

- [Quick start](#quick-start)
- [What to look at first](#what-to-look-at-first)
- [Trying the whole thing](#trying-the-whole-thing)
- [How the pieces fit](#how-the-pieces-fit)
- [Step and trigger reference](#step-and-trigger-reference)
- [LLM provider](#llm-provider)
- [Deploying](#deploying)
- [Repository layout](#repository-layout)

---

## Quick start

Requires Docker, Node 20+, and about five minutes.

```bash
git clone <this repo> && cd <this repo>
cp .env.example .env
cp web/.env.example web/.env.local
npm install
```

Start Postgres, Hasura and nhost Auth:

```bash
docker compose up -d
```

If you already run Postgres on 5432, that maps onto your existing server and
`db:apply` will target the wrong database. Change the mapping to `"55432:5432"` in
`docker-compose.yml` and set `DATABASE_URL` to match — nothing else needs to move,
since Hasura reaches Postgres over the compose network rather than the host port.

Apply the schema and the Hasura metadata, then seed two organisations:

```bash
npm run db:apply
npm run seed
```

The Action and Event Trigger handlers run as a separate process locally (on nhost
they are deployed functions). In a second terminal:

```bash
npm run functions:dev
```

And in a third, the app:

```bash
npm --prefix web install && npm run web:dev
```

Open <http://localhost:3000>. `npm run seed` prints five accounts; they all use the
password `Password123!`.

| Account | Organisation | Role |
| --- | --- | --- |
| `owner.a@example.com` | Northwind Labs | owner |
| `editor.a@example.com` | Northwind Labs | editor |
| `viewer.a@example.com` | Northwind Labs | viewer |
| `owner.b@example.com` | Contoso Support | owner |
| `editor.b@example.com` | Contoso Support | editor |

To check everything is wired up, run the scenario suite against the running stack:

```bash
npm run verify
```

It signs in as real users and asserts 52 things through the public GraphQL
endpoint — no admin secret, no shortcuts — covering both permission layers, all
four trigger types, retries, quota, pause/resume, live subscriptions, and
cross-organisation isolation. It should print `52 passed, 0 failed`.

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run db:apply` | Applies migrations, then metadata |
| `npm run db:reset` | Rolls back through the down migrations and reapplies |
| `npm run seed` | Creates the two demo orgs, members and workflows |
| `npm run verify` | Runs the end-to-end scenario checks |
| `npm run functions:dev` | Serves `functions/` the way nhost does |
| `npm run web:dev` | Next.js dev server on :3000 |

Hasura's console is at <http://localhost:8080> with the admin secret from `.env`.

---

## What to look at first

If you are reviewing this, these are the files that carry the substance:

| Concern | File |
| --- | --- |
| Schema | [`nhost/migrations/default/`](nhost/migrations/default) — six migrations, in order |
| Permission layer 1 | any `nhost/metadata/databases/default/tables/public_*.yaml` |
| Permission layer 2, database half | [`public_workflow_steps.yaml`](nhost/metadata/databases/default/tables/public_workflow_steps.yaml), [`public_workflow_triggers.yaml`](nhost/metadata/databases/default/tables/public_workflow_triggers.yaml) |
| Permission layer 2, handler half | [`functions/_lib/authz.ts`](functions/_lib/authz.ts) |
| The executor | [`functions/_lib/executor.ts`](functions/_lib/executor.ts) |
| Approval pause/resume | [`functions/actions/approve-step.ts`](functions/actions/approve-step.ts) |
| Live subscription | [`web/src/app/runs/[id]/page.tsx`](web/src/app/runs/[id]/page.tsx) |
| Reasoning behind the design | [`WRITEUP.md`](WRITEUP.md) |

---

## Trying the whole thing

Sign in as `owner.a@example.com`, open **Inbound lead triage** and press **Run
workflow**. The dialog is pre-filled with an urgent-sounding message.

1. The run page opens and steps light up as they execute, with no refreshing.
2. `llm_call` classifies the message; `conditional_branch` reads
   `steps.1.output.json.urgency` and takes the urgent path.
3. The run stops on the `approval_gate` and shows **paused**.
4. Approve it. `http_request` makes a real call, `db_write` stores the result with
   the ticket id from that call, and `notify` queues a Slack message that a
   separate Event Trigger delivers.

Then, to see the isolation:

- Copy the run's URL. Sign out, sign in as `owner.b@example.com`, and paste it.
  The page stays empty: the subscription is open, but the row filter never matches
  a run outside your organisation, so nothing is ever pushed. The same is true of
  workflow URLs and of the `approveStep` mutation with a copied step id.
- Sign in as `viewer.a@example.com`. The Run button is gone, and so are the edit
  controls and the webhook token. Those are not just hidden: the Action is not in a
  viewer's GraphQL schema at all, and there is no insert permission behind them.

To start a run without pressing anything:

```bash
# The token is printed by `npm run seed`, and only an owner can read it back.
curl -sX POST http://localhost:8080/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"mutation($t:String!,$p:jsonb){startWorkflowFromWebhook(token:$t,payload:$p){workflow_run_id status accepted}}","variables":{"t":"<webhook token>","p":{"row":{"email":"ops@acme.test","company":"Acme","message":"our integration is down, urgent"}}}}'
```

Note there is no `Authorization` header: this Action is the one thing granted to
the unauthenticated `public` role, and the token is what authorises it.

Or insert a row and let the database do it — **Run workflow → Save as inbound
lead** in the UI, or:

```graphql
mutation { insert_inbound_leads_one(object: {
  org_id: "<org A id>", email: "urgent@newco.test",
  company: "NewCo", message: "checkout is down, we need help immediately"
}) { id } }
```

An `INSERT` on `inbound_leads` fires a Hasura Event Trigger, which starts a run for
every workflow in that organisation watching that table.

---

## How the pieces fit

```
  Next.js (Vercel)
        │  GraphQL queries / mutations / subscriptions, JWT + x-hasura-role
        ▼
  ┌─────────────────────┐        Actions           ┌──────────────────────┐
  │      Hasura         │ ───────────────────────► │  nhost Functions     │
  │                     │  triggerWorkflowRun      │                      │
  │  row permissions    │  approveStep             │  role + quota checks │
  │  scoped to          │  startWorkflowFromWebhook│  the executor        │
  │  org_members        │                          │  step handlers       │
  │                     │ ◄─────────────────────── │                      │
  │                     │   admin-rights writes    └──────────────────────┘
  │                     │   to step_runs / runs             │
  │                     │                                   │ real calls
  │  Event Triggers ────┼──► notifications → delivery       ▼
  │  Cron Trigger ──────┼──► due schedules            LLM API, any HTTP API
  │                     │
  └─────────┬───────────┘
            ▼
        PostgreSQL
```

The important structural choice: **clients never write runs.** `workflow_runs` and
`step_runs` have no insert or update permission for any role. The only way a run
comes into existence is an Action handler that has already checked the caller's
role and the organisation's quota, which is why "a viewer cannot trigger a run" and
"quota cannot be bypassed" hold even against hand-written GraphQL.

---

## Step and trigger reference

Step `config` is JSONB. Strings are interpolated with `{{ path }}` against the run
context, which holds the trigger payload and every earlier step's output:

```
{{trigger.row.email}}
{{steps.1.output.json.urgency}}
{{steps.classify_inbound_lead.output.text}}   # steps are addressable by name too
```

| Step type | Config | Notes |
| --- | --- | --- |
| `llm_call` | `prompt`, `system`, `model`, `max_tokens`, `temperature`, `response_format` | Retried once by default. `output.json` is the parsed reply when it is JSON |
| `http_request` | `method`, `url`, `headers`, `body`, `expect_status`, `timeout_ms` | Retried on timeout, 429 and 5xx; not on 4xx |
| `db_write` | `key`, `payload` | Owner-only. Writes a `workflow_artifacts` row |
| `notify` | `channel` (`slack`/`email`), `target`, `subject`, `body` | Owner-only. Enqueues; an Event Trigger delivers |
| `conditional_branch` | `source`, `operator`, `value`, `on_true`, `on_false` | Operators: `equals`, `not_equals`, `contains`, `not_contains`, `gt`, `gte`, `lt`, `lte`, `regex`, `truthy`, `falsy`. Branches are `{ "goto": n }` or `{ "end": true }` |
| `approval_gate` | `instructions`, `allowed_roles` | Pauses the run. `allowed_roles` narrows who may clear it |

Any step accepts `max_attempts` to override the retry budget.

| Trigger | Config | How it fires |
| --- | --- | --- |
| `manual` | — | The Run button, via `triggerWorkflowRun` |
| `webhook` | `description` | `startWorkflowFromWebhook`, authorised by `webhook_token`. Owner-only to create |
| `schedule` | `cron` (5-field) | A Hasura Cron Trigger calls `events/scheduled-runs` every minute, which evaluates each expression |
| `database_event` | `table` | Hasura Event Trigger on that table. Owner-only to create |

The seeded schedule trigger is present but disabled, so a fresh checkout does not
quietly spend quota every five minutes. Enable it from the workflow page.

---

## LLM provider

`llm_call` works with no API key. With `LLM_PROVIDER=stub` (the default) it waits
about a second and returns a keyword-based classification, and every result is
tagged `"stubbed": true` — visible on the step in the UI — so a stubbed run is never
mistaken for a real one.

For real calls, set two variables in `.env` (all three have free tiers):

```bash
LLM_PROVIDER=groq        LLM_API_KEY=gsk_...     LLM_MODEL=llama-3.3-70b-versatile
LLM_PROVIDER=openrouter  LLM_API_KEY=sk-or-...   LLM_MODEL=meta-llama/llama-3.3-70b-instruct
LLM_PROVIDER=gemini      LLM_API_KEY=AIza...     LLM_MODEL=gemini-2.0-flash
```

`notify` behaves the same way: without `SLACK_WEBHOOK_URL` the notification is
recorded and marked `skipped` rather than `sent`.

---

## Deploying

**Backend (nhost).** Create a project, connect this repository, and set the
secrets referenced by `nhost/nhost.toml` (`HASURA_GRAPHQL_ADMIN_SECRET`,
`HASURA_GRAPHQL_JWT_SECRET`, `NHOST_WEBHOOK_SECRET`, `GRAFANA_ADMIN_PASSWORD` and
the `LLM_*` ones — see `.secrets.example` for the full list). nhost applies
`nhost/migrations` and `nhost/metadata` and deploys `functions/` on push.

The config and the metadata directory are both checked against the real CLI:
`nhost config validate` reports valid, and `hasura metadata apply` — the command
the deploy runs — applies cleanly, including the Actions built from
`actions.graphql`. `hasura migrate status` shows all six migrations as `Present`
in both source and database.

The metadata references `{{NHOST_FUNCTIONS_URL}}` and `{{NHOST_WEBHOOK_SECRET}}`
for every Action, Event Trigger and Cron Trigger, so nothing needs editing between
environments. Confirm `NHOST_FUNCTIONS_URL` is set for the Hasura service to your
project's functions URL.

To run the CLI locally, copy `.secrets.example` to `.secrets` first — the CLI reads
`{{ secrets.* }}` from there, and it is gitignored.

Then seed once against the deployed backend:

```bash
HASURA_GRAPHQL_ENDPOINT=https://<subdomain>.hasura.<region>.nhost.run \
HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
AUTH_URL=https://<subdomain>.auth.<region>.nhost.run/v1 \
npm run seed
```

**Front end (Vercel).** Import the repository with **root directory `web`**, and
set:

```
NEXT_PUBLIC_NHOST_AUTH_URL=https://<subdomain>.auth.<region>.nhost.run/v1
NEXT_PUBLIC_GRAPHQL_URL=https://<subdomain>.hasura.<region>.nhost.run/v1/graphql
NEXT_PUBLIC_GRAPHQL_WS_URL=wss://<subdomain>.hasura.<region>.nhost.run/v1/graphql
```

Add the Vercel URL to `[auth.redirections].allowedUrls` in `nhost.toml`.

`npm run verify` works against a deployed stack too — point `.env` at it.

### Notes from actually deploying this

Five deploys failed before one went green, every one of them in configuration
rather than code. Recording them because most are not obvious from the docs:

- **`nhost config validate` passing is necessary but not sufficient.** The cloud
  validates against an older schema than the CLI carries, and rejected
  `hasura.settings.unauthorizedRole` as an unknown field even though the CLI
  accepted it. Only a real deploy proves a config.
- **Resource requests are not clamped to your plan, they fail.** Asking for 10 GB
  of Postgres on a 1 GB plan fails the whole deploy.
- **`global.environment` rejects `HASURA_`-prefixed names** — reserved. So that is
  not a workaround for a config field the cloud will not take.
- **You do not need to set the unauthorized role.** nhost already resolves
  anonymous requests as `public`: an unauthenticated query returns a *schema*
  error rather than an auth error, which is only possible if a role was resolved.
  `public` is granted nothing anywhere, so it reaches the webhook Action and
  nothing else.
- **`nhost/config.yaml` is required.** The deploy runs the Hasura CLI against
  `nhost/`, and without that file the migrations and metadata step never runs.
  `npm run db:apply` talks to the metadata API directly, so this gap does not
  show up locally — worth running the CLI's own commands
  (`hasura --project nhost migrate apply` / `metadata apply`) before trusting a
  deploy.

### Running the backend without the nhost CLI

`docker-compose.yml` runs the same three services the CLI does, pinned, and mounts
the same migrations and metadata. There is no separate "local" schema. It exists so
the project can be brought up with plain Docker; `nhost up` works equally well.

---

## Repository layout

```
docker-compose.yml             local Postgres + Hasura + Auth
.secrets.example               values for {{ secrets.* }} in nhost/nhost.toml
nhost/
  nhost.toml                   nhost project config
  migrations/default/          six SQL migrations, applied in order
  metadata/                    Hasura metadata in the CLI's own layout
    databases/default/tables/  one file per table: relationships + permissions
                               (auth_*.yaml included so applying metadata does
                                not untrack the tables hasura-auth needs)
    actions.yaml/.graphql      the three Actions and their permissions
    cron_triggers.yaml         the every-minute schedule dispatcher
functions/
  _lib/                        executor, step handlers, authorisation, LLM client
  actions/                     triggerWorkflowRun, approveStep, webhook
  events/                      notification delivery, inbound lead, cron
tools/                         migration/metadata appliers, seed, verify, dev server
web/                           Next.js app
```

`functions/_lib` is shared code, not routes: nhost skips `_`-prefixed paths, and so
does the local dev server.
