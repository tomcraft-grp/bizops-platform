#!/bin/bash
# UNVERIFIED AGAINST THE LIVE PROJECT (production was off limits while this was written; the same files were run on the local PostgreSQL harness instead:
#   node scripts/local-pg/run.mjs <core> supabase/tests/event_boards_down_pre.sql supabase/migrations/20261121110000_event_boards.sql \
#        supabase/rollbacks/20261121110000_event_boards_down.sql supabase/tests/event_boards_down_post.sql).
#
# Proves the rollback of the event boards migration inside ONE transaction that always rolls back (nothing persists):
#   [rewards core, only if it is not applied yet] -> fingerprint of every public function / table / column / policy / constraint / trigger / index
#   -> migration 20261121110000 -> its rollback -> comparison.
#   scripts/run-event-boards-down-proof.sh        # expects "EVENT_BOARDS_DOWN_PROOF n of n passed"
set -euo pipefail
cd "$(dirname "$0")/.."
CORE=supabase/migrations/20261121100000_rewards_core.sql
# Meaningful only while the boards migration is not applied yet (otherwise the "before" snapshot already contains it).
APPLIED=$(bash "$(dirname "$0")/db-readonly.sh" "select to_regclass('public.rw_events') is not null as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the event boards migration is already applied to the live database, so this proof can no longer be run here." >&2; exit 3;; esac
HAS=$(bash "$(dirname "$0")/db-readonly.sh" "select to_regclass('public.rw_rules') is not null as core_applied")
case "$HAS" in
  *'"core_applied":true'*) PRE=();;
  *'"core_applied":false'*) PRE=("$CORE");;
  *) echo "REFUSING: could not tell whether the rewards core is applied (got: $HAS)" >&2; exit 2;;
esac
exec "$(dirname "$0")/run-sql-tests.sh" EVENT_BOARDS_DOWN_PROOF "${PRE[@]}" \
  supabase/tests/event_boards_down_pre.sql supabase/migrations/20261121110000_event_boards.sql \
  supabase/rollbacks/20261121110000_event_boards_down.sql supabase/tests/event_boards_down_post.sql
