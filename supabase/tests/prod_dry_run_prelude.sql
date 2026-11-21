-- ONLY for a dry run of the rewards suites against the LIVE project, sent in the SAME transaction as the suite (scripts/run-sql-tests.sh puts it first), which always ends in a
-- forced rollback: nothing below stays. The suites need one ADMIN profile (the local test data has one; the live project has none).
-- It does what the app does: a real SUPER_ADMIN (identified through the JWT claims, as auth.uid() sees them) turns ONE real member into an ADMIN. The member is the FIFTH oldest
-- active USER, because the suites use the first four as their customers A, B, C and D. The profiles guard trigger checks the caller exactly as it does in production.
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1), 'role', 'authenticated')::text, true);
update public.profiles set role = 'ADMIN'
 where id = (select id from public.profiles where role = 'USER' and status = 'active' order by created_at offset 4 limit 1);
select set_config('request.jwt.claims', '', true);      -- the suites set their own claims every time they act as someone
