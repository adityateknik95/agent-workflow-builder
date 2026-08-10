-- Workflow definitions: the workflow itself, its ordered steps, its triggers.

-- Step and trigger types are reference tables rather than Hasura enum tables
-- because they carry the `requires_owner` policy flag alongside the value.
-- That flag is what the second permission layer keys off, in the database and
-- again in the Action handler, so the policy lives in exactly one place.
CREATE TABLE public.step_types (
  value          text PRIMARY KEY,
  comment        text NOT NULL,
  requires_owner boolean NOT NULL DEFAULT false
);

INSERT INTO public.step_types (value, comment, requires_owner) VALUES
  ('llm_call',           'Calls an LLM provider with a rendered prompt',                false),
  ('http_request',       'Calls an arbitrary external HTTP API',                        false),
  ('db_write',           'Persists a result into this application''s own tables',       true),
  ('notify',             'Sends a Slack/email alert, delivered via a Hasura Event Trigger', true),
  ('conditional_branch', 'Branches on the output of an earlier step',                   false),
  ('approval_gate',      'Pauses the run until a permitted member approves',            false);

CREATE TABLE public.trigger_types (
  value          text PRIMARY KEY,
  comment        text NOT NULL,
  requires_owner boolean NOT NULL DEFAULT false
);

INSERT INTO public.trigger_types (value, comment, requires_owner) VALUES
  ('manual',         'A member with run rights presses Run',                     false),
  ('webhook',        'Inbound Hasura Action an external system calls to start a run', true),
  ('schedule',       'Cron expression evaluated by a scheduled function',         false),
  ('database_event', 'A row change on a watched table starts a run',              true);

CREATE TABLE public.workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflows_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TRIGGER set_workflows_updated_at
  BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

CREATE INDEX workflows_org_id_idx ON public.workflows (org_id);

CREATE TABLE public.workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows (id) ON DELETE CASCADE,
  -- 1-based execution order. conditional_branch jumps refer to these numbers.
  position    integer NOT NULL CHECK (position >= 1),
  type        text NOT NULL REFERENCES public.step_types (value) ON UPDATE CASCADE,
  name        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Kept so the executor can re-check, at execution time, that whoever authored
  -- a privileged step still holds the role that authoring it required.
  created_by  uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- DEFERRABLE so a reorder can swap two positions inside one transaction
  -- (a single Hasura mutation) without tripping the constraint mid-statement.
  CONSTRAINT workflow_steps_position_key UNIQUE (workflow_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT workflow_steps_config_is_object CHECK (jsonb_typeof(config) = 'object')
);

CREATE TRIGGER set_workflow_steps_updated_at
  BEFORE UPDATE ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

CREATE INDEX workflow_steps_workflow_id_position_idx
  ON public.workflow_steps (workflow_id, position);

CREATE TABLE public.workflow_triggers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   uuid NOT NULL REFERENCES public.workflows (id) ON DELETE CASCADE,
  type          text NOT NULL REFERENCES public.trigger_types (value) ON UPDATE CASCADE,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Bearer token for `webhook` triggers. Readable only by owners (column-level
  -- select permission), because possession of it is enough to start a run.
  webhook_token text UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  is_enabled    boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_triggers_config_is_object CHECK (jsonb_typeof(config) = 'object'),
  -- A workflow needs at most one trigger of each kind; keeps the "start it two
  -- different ways" story unambiguous.
  CONSTRAINT workflow_triggers_type_key UNIQUE (workflow_id, type)
);

CREATE TRIGGER set_workflow_triggers_updated_at
  BEFORE UPDATE ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

CREATE INDEX workflow_triggers_workflow_id_idx ON public.workflow_triggers (workflow_id);
CREATE INDEX workflow_triggers_type_enabled_idx ON public.workflow_triggers (type) WHERE is_enabled;

-- A cron expression is required for schedule triggers and meaningless elsewhere.
ALTER TABLE public.workflow_triggers
  ADD CONSTRAINT workflow_triggers_schedule_needs_cron
  CHECK (type <> 'schedule' OR config ? 'cron');
