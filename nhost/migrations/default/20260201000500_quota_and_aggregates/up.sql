-- Quota accounting and the org-level aggregation.

-- Append-only ledger. `organizations.calls_used` is the fast counter the UI
-- reads; this table is the audit trail explaining how it got there, including
-- the attempts that were refused.
CREATE TABLE public.quota_consumptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  workflow_run_id  uuid REFERENCES public.workflow_runs (id) ON DELETE SET NULL,
  amount           integer NOT NULL,
  granted          boolean NOT NULL,
  calls_used_after integer NOT NULL,
  calls_allowed    integer NOT NULL,
  period_start     date NOT NULL,
  reason           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX quota_consumptions_org_created_idx
  ON public.quota_consumptions (org_id, created_at DESC);

-- Atomically roll the period if needed, then check-and-increment under a row
-- lock. Two runs finishing at the same instant cannot both slip past the limit,
-- and the caller learns whether it was granted from the returned row.
--
-- Returns SETOF a real table so Hasura can track it as a mutation. It is not
-- granted to any client role, so only the Action handlers (admin secret) can
-- call it.
CREATE OR REPLACE FUNCTION public.consume_org_quota(
  p_org_id  uuid,
  p_amount  integer,
  p_run_id  uuid DEFAULT NULL,
  p_reason  text DEFAULT 'run_execution'
)
RETURNS SETOF public.quota_consumptions AS $$
DECLARE
  org             public.organizations;
  current_period  date := date_trunc('month', now())::date;
  used            integer;
  will_grant      boolean;
  ledger_row      public.quota_consumptions;
BEGIN
  IF p_amount < 0 THEN
    RAISE EXCEPTION 'quota amount must not be negative' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO org FROM public.organizations WHERE id = p_org_id FOR UPDATE;

  IF org.id IS NULL THEN
    RAISE EXCEPTION 'organisation % does not exist', p_org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Lazy period rollover: the first consumption of a new month resets the counter.
  used := CASE WHEN org.quota_period_start < current_period THEN 0 ELSE org.calls_used END;

  will_grant := (used + p_amount) <= org.calls_allowed;

  IF will_grant THEN
    used := used + p_amount;
  END IF;

  UPDATE public.organizations
     SET calls_used = used,
         quota_period_start = current_period
   WHERE id = p_org_id;

  INSERT INTO public.quota_consumptions
    (org_id, workflow_run_id, amount, granted, calls_used_after, calls_allowed, period_start, reason)
  VALUES
    (p_org_id, p_run_id, p_amount, will_grant, used, org.calls_allowed, current_period, p_reason)
  RETURNING * INTO ledger_row;

  RETURN NEXT ledger_row;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Computed field on workflow_runs: wall-clock duration of the run so far.
-- Exposed in GraphQL as `duration_seconds`.
CREATE OR REPLACE FUNCTION public.workflow_run_duration_seconds(run public.workflow_runs)
RETURNS numeric AS $$
  SELECT round(
    extract(epoch FROM (COALESCE(run.finished_at, now()) - run.started_at))::numeric,
    2
  );
$$ LANGUAGE sql STABLE;

-- The org-level aggregation, as a view so Hasura can apply the same
-- membership-scoped select permission it applies everywhere else.
CREATE VIEW public.org_usage_summary AS
SELECT
  o.id                                        AS org_id,
  o.quota_period_start                        AS period_start,
  o.calls_used,
  o.calls_allowed,
  greatest(o.calls_allowed - o.calls_used, 0) AS calls_remaining,
  COALESCE(r.runs_this_period, 0)             AS runs_this_period,
  COALESCE(r.succeeded_runs, 0)               AS succeeded_runs,
  COALESCE(r.failed_runs, 0)                  AS failed_runs,
  COALESCE(r.paused_runs, 0)                  AS paused_runs,
  r.avg_run_duration_seconds
FROM public.organizations o
LEFT JOIN (
  SELECT
    run.org_id,
    count(*)                                                 AS runs_this_period,
    count(*) FILTER (WHERE run.status = 'succeeded')          AS succeeded_runs,
    count(*) FILTER (WHERE run.status = 'failed')             AS failed_runs,
    count(*) FILTER (WHERE run.status = 'paused')             AS paused_runs,
    round(avg(
      extract(epoch FROM (run.finished_at - run.started_at))
    ) FILTER (WHERE run.finished_at IS NOT NULL AND run.started_at IS NOT NULL)::numeric, 2)
                                                             AS avg_run_duration_seconds
  FROM public.workflow_runs run
  WHERE run.created_at >= date_trunc('month', now())
  GROUP BY run.org_id
) r ON r.org_id = o.id;
