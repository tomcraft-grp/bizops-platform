#!/bin/bash
# Runs the SKU registry change-feed migration and its tests against the live Supabase project inside ONE transaction that always rolls back
# (the test file ends by raising an exception that carries the result table), so nothing persists, not even the new table, triggers and functions.
# Only the new migration is sent: every earlier migration is already live. It refuses to send anything unless every file exists and the
# payload really ends with that closing rollback (see run-sql-tests.sh). Note: a rolled-back transaction still consumes values of the change-log id
# sequence (sequences are not transactional); that only leaves harmless holes in the cursor numbering.
# NOT YET RUN: written for the files' final locations (supabase/migrations/..., after the coordinator moves them out of supabase/wip/).
# Local equivalent (real PostgreSQL, never the Supabase project):
#   node scripts/local-pg/run.mjs --skip sku_registry_sync supabase/migrations/20261121120000_sku_registry_sync.sql supabase/tests/sku_registry_sync.sql
exec "$(dirname "$0")/run-sql-tests.sh" SKU_SYNC_TESTS supabase/migrations/20261121120000_sku_registry_sync.sql supabase/tests/sku_registry_sync.sql
