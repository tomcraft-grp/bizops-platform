#!/bin/bash
# Proves the rollback of the rewards-core migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of every public function / table / column / policy / trigger / constraint / index -> migration 20261121100000 -> its rollback -> comparison.
#   scripts/run-rewards-core-down-proof.sh          # expects "REWARDS_CORE_DOWN_PROOF n of n passed"
# The rollback's refusals (a ledger row, a right, a sold pack, the event boards still installed) are proven on the local PostgreSQL, see
# supabase/tests/rewards_core_down_refuse.sql.
# Local twin (never touches the Supabase project):
#   node scripts/local-pg/run.mjs --skip rewards_core supabase/tests/rewards_core_down_pre.sql supabase/migrations/20261121100000_rewards_core.sql \
#        supabase/rollbacks/20261121100000_rewards_core_down.sql supabase/tests/rewards_core_down_post.sql
set -euo pipefail
cd "$(dirname "$0")/.."
# Meaningful only while the migration is not applied yet (otherwise the "before" snapshot already contains it).
APPLIED=$(bash "$(dirname "$0")/db-readonly.sh" "select to_regclass('public.rw_settings') is not null as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the rewards-core migration is already applied to the live database, so this proof can no longer be run here." >&2; exit 3;; esac
case "$APPLIED" in *'"applied":false'*) ;; *) echo "REFUSING: could not tell whether the migration is live: $APPLIED" >&2; exit 3;; esac
exec "$(dirname "$0")/run-sql-tests.sh" REWARDS_CORE_DOWN_PROOF \
  supabase/tests/rewards_core_down_pre.sql supabase/migrations/20261121100000_rewards_core.sql \
  supabase/rollbacks/20261121100000_rewards_core_down.sql supabase/tests/rewards_core_down_post.sql
