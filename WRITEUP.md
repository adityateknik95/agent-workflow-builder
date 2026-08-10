# Write-up

## Schema reasoning

The spine is `organisation → members → workflows → steps/triggers` and
`workflow → runs → step_runs`. Two decisions carry the design.

**`org_members` is the only authority on who can do what.** There is no global
notion of "an editor" — a user is an editor *of an organisation*, and one row says
so. Because that row is unique per `(org_id, user_id)`, "what is this caller's role
here" has exactly one answer, which is what lets every permission be written as the
same predicate.

**Runs carry a denormalised `org_id`.** Checking permissions on `step_runs` would
otherwise mean walking `run → workflow → org → members` on every row, and that is
the table under the live subscription, re-filtered on every push. So `org_id` sits
directly on `workflow_runs` and `step_runs` and the filter is one indexed join. The
usual risk with denormalisation is drift, so the column is never accepted from the
caller: a `BEFORE INSERT` trigger derives it from the parent and overwrites whatever
was supplied. Passing another org's id does not smuggle a run anywhere.

Four smaller choices that earned their place. Roles and statuses are Hasura **enum
tables**, so they are GraphQL enums rather than free text — which caught a real bug,
a mutation declaring `$status: String!` refused because the column is
`run_statuses_enum`. Step and trigger types are **reference tables carrying a
`requires_owner` flag**, putting the second layer's whole policy in one place. Step
order is `position` with a **`DEFERRABLE`** unique constraint, so a reorder is two
updates in one transaction. And all `step_runs` are created up front as `pending`, so
a client that subscribes immediately renders the entire plan and watches it fill in.

## The two permission layers are enforced by different mechanisms

They answer different kinds of question.

**Layer 1 — who may see or touch a row: Hasura row permissions.** The app asks
Hasura to act as `owner`, `editor` or `viewer`. That header is only a *request*;
every permission resolves it against `org_members`:

```yaml
filter:
  org: { members: { _and: [ {user_id: {_eq: X-Hasura-User-Id}}, {role: {_eq: editor}} ] } }
```

The role is a literal, matched against the membership row for the org that owns
*that row*. Two consequences fall out of the shape rather than any extra code: an
editor in Org A gets nothing from Org B even when naming a primary key
(`workflows_by_pk` returns `null`, indistinguishable from a row that does not
exist); and a viewer asking for `x-hasura-role: owner` sees zero rows, because the
token permits requesting the role while the database decides they do not hold it.

**Layer 2 — who may act on specific steps: split between the database and the
handler.** Half is expressible as a row rule and half is not.

The half that is: an editor's insert permission on `workflow_steps` joins through to
`step_type.requires_owner`, so `db_write` and `notify` are refused by the permission
itself. The same clause sits in the update permission's `filter` **and** `check`, so
an editor can neither edit a privileged step nor convert an ordinary one into it.
There is also a column-level piece — `webhook_token` is absent from the viewer and
editor select permissions.

The half that is not: **clearing an `approval_gate`** is a decision taken mid-run —
check the approver's role, record who decided, flip the gate, resume the executor.
No row rule expresses that, so `step_runs` has **no** update permission for any
client role and the `approveStep` handler is the only way through. And **running** a
privileged step is checked separately from authoring one: before executing a
`db_write` or `notify`, the executor confirms the step's author is *currently* an
owner, so a step written by someone since demoted stops working.

Both layers apply to machine-started runs too. The webhook Action is granted to the
unauthenticated `public` role and carries no session, so its authorisation is the
trigger's token; the database Event Trigger and cron dispatcher have no user at all.
All four paths call the same executor. One detail matters for isolation: "you are not
a member" and "this does not exist" return the same 404 with the same message, since
error text that distinguishes them confirms a guessed id is real.

## Pause and resume on an approval gate

The state lives in the database, not in the handler, so a paused run survives a
redeploy — two of them in this deployment did.

**Pausing.** The executor walks steps by `position`. Reaching an `approval_gate` it
executes nothing: it sets the `step_run` to `paused`, copies the gate's instructions
and permitted roles into `input` for the UI, writes `resume_from_position` (the
position *after* the gate) on the run, sets the run `paused`, and returns. Because
the subscription is on `step_runs`, the browser sees the pause as it is written.

**Resuming.** `approveStep` verifies the approver against `org_members`, intersected
with the gate's own `allowed_roles`, then makes two **guarded** updates before doing
any work — `where: { id, status: { _eq: paused } }` on the step and on the run. Each
returns `affected_rows`; a zero means someone else already decided, and the handler
stops with a conflict instead of executing the tail of the run twice. Only then does
the executor reload the run, rebuild its template context from the `step_runs`
already recorded (the outputs *are* the state — there is no serialised blob to keep
in sync), and continue from `resume_from_position`, walking past the now-`succeeded`
gate so one loop handles both a fresh and a resumed run.

Quota is settled at every boundary including the pause, comparing `external_calls`
against `calls_charged`, so a run paused for a week is still billed for the call it
already made and only the remainder is charged on resume. The accounting takes a row
lock, rolls the period over lazily, then checks and increments under that lock, so two
runs finishing at the same instant cannot both slip past the limit.

---

Longer notes on the same ground, plus what I would do next, are in
[DESIGN.md](DESIGN.md).
