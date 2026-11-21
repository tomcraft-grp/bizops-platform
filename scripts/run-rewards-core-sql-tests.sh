#!/bin/bash
# Runs the rewards-core migration and its tests against the live Supabase project inside ONE transaction that always rolls back
# (the test file ends by raising an exception that carries the result table), so nothing persists, not even the tables and functions the migration creates.
# It refuses to send anything unless every file exists and the payload really ends with that closing rollback (see run-sql-tests.sh).
# Expects "REWARDS_CORE_TESTS n of n passed". Only meaningful while the migration is NOT applied to the live database (otherwise it would try to create everything twice).
# Without a valid ~/.supabase-token use the local twin instead (never touches the Supabase project):
#   node scripts/local-pg/run.mjs --skip rewards_core supabase/migrations/20261121100000_rewards_core.sql supabase/tests/rewards_core.sql
exec "$(dirname "$0")/run-sql-tests.sh" REWARDS_CORE_TESTS supabase/migrations/20261121100000_rewards_core.sql supabase/tests/rewards_core.sql
