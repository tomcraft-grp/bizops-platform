-- Proof that the rollback REFUSES once a points-ledger row exists (local harness only; it is meant to end in an error, so it has no result table):
--   node scripts/local-pg/run.mjs supabase/migrations/20261121100000_rewards_core.sql supabase/tests/rewards_core_down_refuse.sql supabase/rollbacks/20261121100000_rewards_core_down.sql
-- (during development: the same with the supabase/wip/ copies of the two SQL files). Expected: "UNEXPECTED ERROR ... Reward points exist: the points ledger is a record
-- and cannot be rolled back." and exit code 1. Use --skip rewards_core while the migration is not yet in supabase/migrations/.
insert into public.rw_points_ledger (profile_id, points, kind, source_key, note)
select id, 5, 'earn', 'adjust-test', 'a point exists' from public.profiles where role = 'USER' order by created_at limit 1;
