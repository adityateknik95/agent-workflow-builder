# Design notes

Three things in this project were worth thinking about properly: how the schema is
shaped, how the two permission layers end up being enforced by different
mechanisms, and how a run pauses in the middle and picks up again later.

## Schema

The spine is `organisation → members → workflows → steps/triggers` and
`workflow → runs → step_runs`. Two decisions in there are load-bearing.

**`org_members` is the only authority on who can do what.** There is no global
notion of "an editor". A user is an editor *of an organisation*, and a single row
says so. Because that row is unique per `(org_id, user_id)`, the question "what is
this caller's role here" has exactly one answer, which is what lets every
permission be written as the same predicate. A constraint trigger stops the last
owner of an organisation being demoted or removed, since an org with no owner
cannot be administered back to health.

**Runs carry a denormalised `org_id`.** Permission checks on `workflow_runs` and
`step_runs` would otherwise have to walk `run → workflow → org → members` on every
row, and `step_runs` is the table under the live subscription, re-filtered on every
push. So `org_id` sits directly on both tables and the filter is a single indexed
join. The risk with denormalisation is drift, so the column is never accepted from
the caller: a `BEFORE INSERT` trigger derives it from the parent row and overwrites
whatever was supplied. Passing another organisation's `org_id` does not smuggle a
run anywhere — it is simply ignored.

Smaller choices that paid off:

- **Roles and run statuses are Hasura enum tables**, so they appear in the GraphQL
  schema as enums rather than strings. This caught a real bug during development: a
  mutation declared `$status: String!` and Hasura refused it because the column is
  `run_statuses_enum`.
- **Step and trigger types are reference tables with a `requires_owner` flag**
  rather than enums. That flag is the whole of the second permission layer's policy,
  and it lives in one place that both the database rules and the handler read.
  Adding a new privileged step type is one row, not an audit of the codebase.
- **Step ordering is `position` with a `DEFERRABLE` unique constraint** on
  `(workflow_id, position)`. Reordering is then two updates in one mutation —
  Hasura runs them in a single transaction, and the moment where both rows briefly
  hold the same position is never checked.
- **`step_runs` are all created up front** as `pending` when a run starts, so a
  client that subscribes immediately renders the entire plan and watches rows change
  state, rather than seeing steps appear one at a time.
- **Run history is immutable.** `step_runs` snapshots the step's type, name and
  position, and the foreign key is `ON DELETE SET NULL`, so deleting a step later
  does not rewrite what happened.
- The required aggregation is the `org_usage_summary` view: quota position for the
  period, run counts, and average run duration. The UI subscribes to it, so the
  quota meter moves on its own.

## The two permission layers

They are enforced by different mechanisms because they are different kinds of
question.

### Layer 1 — who can see or touch a row: Hasura row permissions

The app authenticates once and then asks Hasura to act as `owner`, `editor` or
`viewer`. That header is only a *request*. Every permission on every table resolves
it against `org_members`:

```yaml
filter:
  org:
    members:
      _and:
        - user_id: { _eq: X-Hasura-User-Id }
        - role: { _eq: editor }
```

The role in the predicate is a literal, matched against the membership row for the
organisation that owns *that row*. Two consequences fall out of this shape rather
than out of any extra code:

- An editor in Org A gets nothing from Org B, because no membership row joins them —
  including when they name a primary key directly. `workflows_by_pk(id: …)` on
  another org's workflow returns `null`, indistinguishable from an id that does not
  exist.
- A viewer who asks for `x-hasura-role: owner` sees zero rows. The token permits
  them to request the role; the database decides they do not hold it. There is no
  code path where a role claim is trusted on its own.

`viewer` differs from `editor` by having no insert/update/delete permissions at all;
`editor` differs from `owner` by having none on `org_members`. There is also a
bootstrap role, `user`, which can read only its own membership rows — enough to
populate the organisation switcher and nothing else.

### Layer 2 — who can act on specific steps: split between the database and the handler

Some step types reach outside the sandbox, and the rule is that only an owner may
introduce them. Half of that is expressible as a row rule, and half is not.

**The half that is.** An editor's insert permission on `workflow_steps` joins
through to the step type:

```yaml
check:
  _and:
    - workflow: { org: { members: { _and: [ {user_id: {_eq: X-Hasura-User-Id}}, {role: {_eq: editor}} ] } } }
    - step_type: { requires_owner: { _eq: false } }
```

The same clause appears in the update permission's `filter` *and* its `check`, so an
editor can neither edit an existing privileged step nor convert an ordinary step
into one. Trigger types work identically, which is what stops an editor attaching a
webhook. There is also a column-level piece: `webhook_token` is absent from the
viewer and editor select permissions, because holding that token is enough to start
runs — an editor can see that a webhook trigger exists but cannot read its secret.

**The half that is not.** Two cases cannot be a row rule:

1. *Clearing an `approval_gate`.* This is a decision taken part way through an
   execution. It has to check the approver's role, record who decided and when, flip
   the gate, and then resume the executor from the next step. No row-level rule
   describes that, so `step_runs` has **no** update permission for any client role,
   and the `approveStep` handler is the only way through the gate. It re-reads the
   approver's membership of the run's organisation, and intersects it with the
   gate's own `allowed_roles`, so a workflow can demand an owner specifically.

2. *Running a privileged step.* The insert rules govern who may **author** a
   `db_write` or `notify` step; they say nothing about whether that authorisation
   still holds when the step actually runs, possibly weeks later. So before
   executing either type the executor checks that the step's author is *currently*
   an owner of the organisation
   ([`functions/_lib/authz.ts`](functions/_lib/authz.ts)). An editor promoted to
   owner, who writes a `db_write` step and is then demoted, does not leave a working
   privileged step behind. It also means a step inserted through any path that
   bypassed the insert permission never executes.

Both layers also apply to runs started by machines. The webhook Action is granted to
the unauthenticated `public` role — deliberately, it is an inbound endpoint — and
carries no session at all, so its authorisation is the trigger's own token. The
database Event Trigger and the cron dispatcher have no user either. All four paths
call the same executor, so quota and step-level checks apply to a run started by a
row insert exactly as they do to one started by the button.

A detail that matters for isolation: "you are not a member of this organisation" and
"this id does not exist" return the same 404 with the same message. Error text is a
side channel, and telling the two apart would confirm that a guessed id is real.

## Pausing and resuming on an approval gate

The state lives in the database, not in the handler's memory, so a paused run
survives a redeploy and does not depend on anything staying resident.

**Pausing.** The executor walks steps by `position`. When it reaches an
`approval_gate` it does not execute anything: it sets the `step_run` to `paused`,
copies the gate's instructions and permitted roles into the step's `input` so the UI
can render them, writes `resume_from_position` on the run — the position *after* the
gate — sets the run to `paused`, and returns. Because the subscription is on
`step_runs`, the browser sees the pause the moment it is written.

**Resuming.** `approveStep` verifies the approver, then makes two guarded updates
before doing any work:

```graphql
update_step_runs(where: { id: { _eq: $id }, status: { _eq: paused } }, ...)
update_workflow_runs(where: { id: { _eq: $id }, status: { _eq: paused } }, ...)
```

Each returns `affected_rows`. If either is zero, someone else already decided this
gate or already resumed this run, and the handler stops with a conflict instead of
executing the tail of the run twice. Two approvers pressing the button
simultaneously is a race the database settles, not one the handler hopes to avoid.

Only then does the executor reload the run, rebuild the template context from the
`step_runs` rows already recorded — the outputs are the state, there is no
serialised blob to keep in sync — and continue from `resume_from_position`. It walks
past the now-`succeeded` gate on the way through, so the same loop handles a fresh
run and a resumed one. Rejecting instead marks the gate `rejected`, skips what is
left, and fails the run.

Quota is settled at every boundary, including the pause, using `external_calls`
against `calls_charged`. A run that pauses for a week has still been billed for the
LLM call it made before pausing, and when it resumes only the difference is charged.
The accounting itself is a single `SECURITY`-style function that takes a row lock,
rolls the period over lazily if the stored month is stale, and checks and increments
under that lock, so two runs finishing at the same instant cannot both slip past the
limit. It writes a ledger row either way, including for refusals, and that ledger
table is granted to no client role — which is also what keeps the function callable
only by the handlers.

## What I would do next

- **Long runs.** The Actions are synchronous, which is fine for these steps and
  gives the caller a real result, but a genuinely long workflow wants an
  asynchronous Action or a queue. The database already supports it: `pending` runs
  and `resume_from_position` mean a worker could pick up where anything left off.
- **Parallel steps.** Ordering is linear. A DAG would need a predecessor table
  rather than a single `position`, and the executor would need a ready-set instead of
  a cursor.
- **Secrets in step configs.** `http_request` headers are stored in plain JSONB.
  Anything real needs a per-organisation secret store referenced by name, so tokens
  never sit in a workflow definition that every member can read.
- **Rate limiting the webhook Action.** The token authorises it, but nothing throttles
  it beyond the org quota; Hasura's API limits or a counter keyed on the trigger
  would close that gap.
