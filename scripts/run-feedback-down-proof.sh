#!/bin/bash
# Proves the feedback English-context rollback inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the live schema -> migration -> [guard scenario: an English context exists] -> rollback -> comparison.
#   scripts/run-feedback-down-proof.sh           # the rollback must restore the schema exactly (expects "FEEDBACK_DOWN_PROOF n of n passed")
#   scripts/run-feedback-down-proof.sh guard     # the rollback must REFUSE because an issue carries an English context
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-clean}"
# This proof compares the schema before and after "migration + rollback" INSIDE a rolled-back transaction, so it only means something while the
# live database does not have the migration yet. Once it is applied, the "before" snapshot already contains it: refuse instead of reporting nonsense.
APPLIED=$(bash "$(dirname "$0")/db-readonly.sh" "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bizops_feedback_issues' and column_name = 'english_context') as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the feedback English-context migration is already applied to the live database, so this proof can no longer be run here (it passed before it was applied)." >&2; exit 3;; esac
GUARD=$(mktemp); trap 'rm -f "$GUARD"' EXIT
if [ "$MODE" = "guard" ]; then
  # the rollback refuses once an issue carries an English context (the rows exist only inside this transaction, which is rolled back)
  cat > "$GUARD" <<'SQL'
update public.bizops_feedback_issues set english_context = 'guard text', english_context_status = 'completed', english_context_source = 'manual'
  where id = (select id from public.bizops_feedback_issues order by id limit 1);
SQL
else
  printf "%s\n" "select 1;" > "$GUARD"
fi
exec "$(dirname "$0")/run-sql-tests.sh" FEEDBACK_DOWN_PROOF \
  supabase/tests/feedback_down_pre.sql supabase/migrations/20261115600000_feedback_english_context.sql "$GUARD" \
  supabase/rollbacks/20261115600000_feedback_english_context_down.sql supabase/tests/feedback_down_post.sql
