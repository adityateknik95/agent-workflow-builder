-- Read-only projection of membership joined to the auth user, so the UI can show
-- who is in an org and who approved a gate without granting any client role
-- access to auth.users itself. Hasura applies the usual org-scoped select
-- permission on this view.
CREATE VIEW public.org_member_profiles AS
SELECT
  m.id            AS org_member_id,
  m.org_id,
  m.user_id,
  m.role,
  u.email::text   AS email,
  u.display_name,
  m.created_at
FROM public.org_members m
JOIN auth.users u ON u.id = m.user_id;
