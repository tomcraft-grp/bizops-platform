#!/bin/bash
# UNVERIFIED AGAINST THE LIVE PROJECT (written while ~/.supabase-token was invalid and production was off limits; the same files were run on the local
# PostgreSQL harness instead: node scripts/local-pg/run.mjs <core> supabase/migrations/20261121110000_event_boards.sql supabase/tests/event_boards.sql).
#
# Runs the event boards migration and its tests against the live Supabase project inside ONE transaction that always rolls back (the test file ends by raising an
# exception that carries the result table), so nothing persists, not even the tables. It refuses to send anything unless every file exists and the payload really ends
# with that closing rollback (see run-sql-tests.sh).
# The boards migration needs the rewards core (rw_settings, rw_rules, rw_entitlements, rw_events_log, rw_is_staff ...). If the core is not applied to the live
# database yet, its migration is sent first, in the same rolled-back transaction; if it is applied, it is left out (it would fail on "already exists").
#   scripts/run-event-boards-sql-tests.sh          # expects "EVENT_BOARDS_TESTS n of n passed"
set -euo pipefail
cd "$(dirname "$0")/.."
CORE=supabase/migrations/20261121100000_rewards_core.sql
HAS=$(bash "$(dirname "$0")/db-readonly.sh" "select to_regclass('public.rw_rules') is not null as core_applied")
case "$HAS" in
  *'"core_applied":true'*) FILES=(supabase/migrations/20261121110000_event_boards.sql supabase/tests/event_boards.sql);;
  *'"core_applied":false'*) FILES=("$CORE" supabase/migrations/20261121110000_event_boards.sql supabase/tests/event_boards.sql);;
  *) echo "REFUSING: could not tell whether the rewards core is applied (got: $HAS)" >&2; exit 2;;
esac
exec "$(dirname "$0")/run-sql-tests.sh" EVENT_BOARDS_TESTS "${FILES[@]}"
