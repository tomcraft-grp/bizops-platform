#!/bin/bash
# Proves the rollback of the translation-source migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the live schema -> migration 20261115620000 -> [guard scenario] -> its rollback -> comparison.
#   scripts/run-feedback-translation-down-proof.sh          # expects "FEEDBACK_TRANSLATION_DOWN_PROOF n of n passed"
#   scripts/run-feedback-translation-down-proof.sh guard    # the rollback must REFUSE because a translation is stored
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-clean}"
# Meaningful only while the migration is not applied yet (otherwise the "before" snapshot already contains it).
APPLIED=$(bash "$(dirname "$0")/db-readonly.sh" "select to_regprocedure('public.feedback_set_english_context(text, text, text)') is not null as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the translation-source migration is already applied to the live database, so this proof can no longer be run here (it passed before it was applied)." >&2; exit 3;; esac
GUARD=$(mktemp); trap 'rm -f "$GUARD"' EXIT
if [ "$MODE" = "guard" ]; then
  printf "%s\n" "update public.bizops_feedback_issues set english_context = 'guard text', english_context_status = 'completed', english_context_source = 'translation' where id = (select id from public.bizops_feedback_issues order by id limit 1);" > "$GUARD"
else
  printf "%s\n" "select 1;" > "$GUARD"
fi
exec "$(dirname "$0")/run-sql-tests.sh" FEEDBACK_TRANSLATION_DOWN_PROOF \
  supabase/tests/feedback_down_pre.sql supabase/migrations/20261115620000_feedback_translation_source.sql "$GUARD" \
  supabase/rollbacks/20261115620000_feedback_translation_source_down.sql supabase/tests/feedback_translation_down_post.sql
