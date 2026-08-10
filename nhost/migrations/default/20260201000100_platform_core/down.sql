DROP TRIGGER IF EXISTS org_members_keep_an_owner ON public.org_members;
DROP FUNCTION IF EXISTS public.assert_org_keeps_an_owner();
DROP TABLE IF EXISTS public.org_members;
DROP TABLE IF EXISTS public.organizations;
DROP TABLE IF EXISTS public.org_roles;
DROP FUNCTION IF EXISTS public.set_current_timestamp_updated_at();
