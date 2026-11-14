#!/bin/bash
# Proves the rollback of the feedback English-context limits migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the live schema -> migration 20261115610000 -> its rollback -> comparison (expects "FEEDBACK_LIMITS_DOWN_PROOF n of n passed").
set -euo pipefail
cd "$(dirname "$0")/.."
# Meaningful only while the limits migration is not applied yet (otherwise the "before" snapshot already contains it).
APPLIED=$(bash "$(dirname "$0")/db-readonly.sh" "select position('RATE_LIMITED' in pg_get_functiondef('public.feedback_english_context_begin(text, uuid)'::regprocedure)) > 0 as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the limits migration is already applied to the live database, so this proof can no longer be run here (it passed before it was applied)." >&2; exit 3;; esac
exec "$(dirname "$0")/run-sql-tests.sh" FEEDBACK_LIMITS_DOWN_PROOF \
  supabase/tests/feedback_down_pre.sql supabase/migrations/20261115610000_feedback_english_context_limits.sql \
  supabase/rollbacks/20261115610000_feedback_english_context_limits_down.sql supabase/tests/feedback_limits_down_post.sql
