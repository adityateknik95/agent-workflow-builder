-- Organisations, membership and roles.
--
-- Everything in this product is owned by an organisation. `org_members` is the
-- single place that answers "which orgs does this user belong to, and as what",
-- and every Hasura permission in the project routes back to it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_current_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Hasura enum table: text PK + optional `comment` column only, so the role
-- shows up in the GraphQL schema as a real enum instead of a free-text string.
CREATE TABLE public.org_roles (
  value   text PRIMARY KEY,
  comment text NOT NULL
);

INSERT INTO public.org_roles (value, comment) VALUES
  ('owner',  'Full control: workflows, steps, triggers, members and privileged step types'),
  ('editor', 'Can build workflows and trigger runs, cannot manage members or privileged steps'),
  ('viewer', 'Read-only, cannot trigger a run');

CREATE TABLE public.organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  -- Usage quota. `calls_used` is reset lazily by consume_org_quota() whenever
  -- the stored period is older than the current calendar month, so no cron job
  -- is required to roll the window over.
  quota_period_start date NOT NULL DEFAULT date_trunc('month', now())::date,
  calls_used         integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
  calls_allowed      integer NOT NULL DEFAULT 200 CHECK (calls_allowed >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

CREATE TRIGGER set_organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

CREATE TABLE public.org_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  role       text NOT NULL REFERENCES public.org_roles (value) ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One membership row per user per org: the role for a given (user, org) pair
  -- is therefore unambiguous, which is what the permission layer relies on.
  CONSTRAINT org_members_org_user_key UNIQUE (org_id, user_id)
);

CREATE TRIGGER set_org_members_updated_at
  BEFORE UPDATE ON public.org_members
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- Permission predicates always look like "does a row exist in org_members for
-- this user (and optionally this role) in this org", so index for exactly that.
CREATE INDEX org_members_user_id_idx ON public.org_members (user_id);
CREATE INDEX org_members_org_id_role_idx ON public.org_members (org_id, role);

-- An org must keep at least one owner, otherwise it becomes unadministrable.
CREATE OR REPLACE FUNCTION public.assert_org_keeps_an_owner()
RETURNS TRIGGER AS $$
DECLARE
  target_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  owners     integer;
BEGIN
  -- If the org itself is gone there is nothing left to protect.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = target_org) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO owners
  FROM public.org_members
  WHERE org_id = target_org AND role = 'owner';

  IF owners = 0 THEN
    RAISE EXCEPTION 'organisation % must retain at least one owner', target_org
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER org_members_keep_an_owner
  AFTER UPDATE OR DELETE ON public.org_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_org_keeps_an_owner();
