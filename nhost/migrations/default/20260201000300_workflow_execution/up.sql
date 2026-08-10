-- Execution history: one workflow_run per execution, one step_run per step.

CREATE TABLE public.run_statuses (
  value   text PRIMARY KEY,
  comment text NOT NULL
);

INSERT INTO public.run_statuses (value, comment) VALUES
  ('pending',   'Created, not yet picked up by the executor'),
  ('running',   'Executor is working through the steps'),
  ('paused',    'Stopped on an approval_gate, waiting for a decision'),
  ('succeeded', 'All reachable steps finished successfully'),
  ('failed',    'A step exhausted its retries, or the run was rejected'),
  ('cancelled', 'Stopped by a member before finishing');

CREATE TABLE public.step_run_statuses (
  value   text PRIMARY KEY,
  comment text NOT NULL
);

INSERT INTO public.step_run_statuses (value, comment) VALUES
  ('pending',   'Queued as part of the run, not started'),
  ('running',   'In flight'),
  ('paused',    'approval_gate reached; awaiting approval'),
  ('succeeded', 'Completed successfully'),
  ('failed',    'Failed after exhausting retries'),
  ('rejected',  'An approver explicitly rejected this gate'),
  ('skipped',   'Not reached, because a conditional_branch routed around it');

CREATE TABLE public.workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid NOT NULL REFERENCES public.workflows (id) ON DELETE CASCADE,
  -- Denormalised from the workflow and maintained by a trigger below. Every
  -- permission check on runs and step_runs is then a single indexed join to
  -- org_members instead of walking workflow -> org on every row.
  org_id       uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
                 REFERENCES public.run_statuses (value) ON UPDATE CASCADE,
  trigger_type text NOT NULL REFERENCES public.trigger_types (value) ON UPDATE CASCADE,
  -- Null for runs started by a webhook, a schedule or a database event.
  triggered_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where the executor should pick up after an approval_gate is cleared.
  resume_from_position integer,
  -- Billable external calls (llm_call / http_request attempts) this run has made,
  -- and how many of them have already been charged to the org's quota. Keeping
  -- both means a run that pauses on an approval gate can be settled for the work
  -- it has done so far, and settled again for the remainder when it resumes,
  -- without ever double-charging.
  external_calls integer NOT NULL DEFAULT 0 CHECK (external_calls >= 0),
  calls_charged  integer NOT NULL DEFAULT 0 CHECK (calls_charged >= 0),
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_workflow_runs_updated_at
  BEFORE UPDATE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

CREATE TABLE public.step_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs (id) ON DELETE CASCADE,
  -- Set null if the definition is later deleted; the snapshot columns below keep
  -- the history readable regardless.
  workflow_step_id uuid REFERENCES public.workflow_steps (id) ON DELETE SET NULL,
  org_id          uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  position        integer NOT NULL,
  step_type       text NOT NULL REFERENCES public.step_types (value) ON UPDATE CASCADE,
  step_name       text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    REFERENCES public.step_run_statuses (value) ON UPDATE CASCADE,
  input           jsonb,
  output          jsonb,
  error           text,
  attempt         integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  -- approval_gate bookkeeping. Written only by the approveStep Action handler,
  -- after it has verified the approver's role in this org.
  approved_by     uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  approved_at     timestamptz,
  approval_note   text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- All step_runs for a run are created up-front as `pending`, so the live
  -- subscription can render the whole plan immediately and light rows up as the
  -- executor moves through them.
  CONSTRAINT step_runs_run_step_key UNIQUE (workflow_run_id, workflow_step_id)
);

CREATE TRIGGER set_step_runs_updated_at
  BEFORE UPDATE ON public.step_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- The live subscription is "step_runs where workflow_run_id = X order by position".
CREATE INDEX step_runs_run_id_position_idx ON public.step_runs (workflow_run_id, position);
CREATE INDEX step_runs_org_id_idx ON public.step_runs (org_id);
CREATE INDEX workflow_runs_workflow_id_created_idx
  ON public.workflow_runs (workflow_id, created_at DESC);
CREATE INDEX workflow_runs_org_id_status_idx ON public.workflow_runs (org_id, status);

-- Owning org is derived from the parent row, never supplied by the caller, so a
-- forged org_id cannot be used to smuggle a run into someone else's org.
CREATE OR REPLACE FUNCTION public.workflow_runs_set_org_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT w.org_id INTO NEW.org_id
  FROM public.workflows w
  WHERE w.id = NEW.workflow_id;

  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'workflow % does not exist', NEW.workflow_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_runs_derive_org_id
  BEFORE INSERT OR UPDATE OF workflow_id ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.workflow_runs_set_org_id();

CREATE OR REPLACE FUNCTION public.step_runs_set_org_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT r.org_id INTO NEW.org_id
  FROM public.workflow_runs r
  WHERE r.id = NEW.workflow_run_id;

  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'workflow run % does not exist', NEW.workflow_run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER step_runs_derive_org_id
  BEFORE INSERT OR UPDATE OF workflow_run_id ON public.step_runs
  FOR EACH ROW EXECUTE FUNCTION public.step_runs_set_org_id();

-- An approval decision must always be attributable.
ALTER TABLE public.step_runs
  ADD CONSTRAINT step_runs_approval_is_attributed
  CHECK ((approved_by IS NULL) = (approved_at IS NULL));
