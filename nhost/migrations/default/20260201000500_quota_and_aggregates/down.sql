DROP VIEW IF EXISTS public.org_usage_summary;
DROP FUNCTION IF EXISTS public.workflow_run_duration_seconds(public.workflow_runs);
DROP FUNCTION IF EXISTS public.consume_org_quota(uuid, integer, uuid, text);
DROP TABLE IF EXISTS public.quota_consumptions;
