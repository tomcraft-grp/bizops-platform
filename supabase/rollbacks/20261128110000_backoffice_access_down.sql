-- Rolls back 20261128110000_backoffice_access.sql: drops the one function. Roles already given (profiles.role) and the audit rows stay as they are: they are data, and a SUPER_ADMIN can still
-- change a role by hand as before. Afterwards delete version 20261128110000 from supabase_migrations.schema_migrations.
drop function if exists public.line_member_set_access(uuid, boolean, text);
