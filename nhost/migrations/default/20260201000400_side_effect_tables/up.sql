-- Tables the step types write into, plus the table watched by the database
-- Event Trigger.

-- Target of `db_write` steps: results the workflow persists into our own schema.
CREATE TABLE public.workflow_artifacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs (id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES public.step_runs (id) ON DELETE SET NULL,
  key             text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_artifacts_org_id_idx ON public.workflow_artifacts (org_id);
CREATE INDEX workflow_artifacts_run_id_idx ON public.workflow_artifacts (workflow_run_id);

-- Queue for `notify` steps. The executor only enqueues; a Hasura Event Trigger
-- on INSERT calls the delivery function, which updates status/delivered_at.
-- That keeps a slow Slack endpoint off the run's critical path and gives
-- delivery its own retry budget, managed by Hasura.
CREATE TABLE public.notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES public.workflow_runs (id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES public.step_runs (id) ON DELETE SET NULL,
  channel         text NOT NULL CHECK (channel IN ('slack', 'email')),
  target          text,
  subject         text,
  body            text NOT NULL,
  -- `skipped` covers a deployment with no Slack/SMTP configured: the message is
  -- recorded, and the UI never claims it was delivered when it was not.
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempt         integer NOT NULL DEFAULT 0,
  error           text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_notifications_updated_at
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

CREATE INDEX notifications_org_id_idx ON public.notifications (org_id);

-- The table watched by the `database_event` trigger type. Inserting a lead is
-- the "row change in a watched table" that starts a run with no button click.
CREATE TABLE public.inbound_leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  email      text NOT NULL,
  company    text,
  message    text,
  source     text NOT NULL DEFAULT 'web_form',
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_leads_org_id_created_idx ON public.inbound_leads (org_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.derive_org_id_from_run()
RETURNS TRIGGER AS $$
DECLARE
  derived uuid;
BEGIN
  IF NEW.workflow_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT r.org_id INTO derived
  FROM public.workflow_runs r
  WHERE r.id = NEW.workflow_run_id;

  IF derived IS NULL THEN
    RAISE EXCEPTION 'workflow run % does not exist', NEW.workflow_run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.org_id := derived;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_artifacts_derive_org_id
  BEFORE INSERT ON public.workflow_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.derive_org_id_from_run();

CREATE TRIGGER notifications_derive_org_id
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.derive_org_id_from_run();
