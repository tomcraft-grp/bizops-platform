#!/bin/bash
# Proves the numbering rollback inside ONE transaction that always rolls back (nothing persists):
#   migrations 1-4 -> schema fingerprint -> migration 5 -> [guard scenario: a counter that issued a number] -> rollback -> comparison.
#   scripts/run-numbering-down-proof.sh           # the rollback must restore the schema exactly (expects "NUMBERING_DOWN_PROOF n of n passed")
#   scripts/run-numbering-down-proof.sh guard     # the rollback must REFUSE because the new numbering already issued a number
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-clean}"
# This proof compares the schema before and after "migration + rollback" INSIDE a rolled-back transaction, so it only means something while the
# live database does not have the migration yet. Once it is applied, the "before" snapshot already contains it: refuse instead of reporting nonsense.
APPLIED=$(bash "$(dirname "$0")/db-readonly.sh" "select to_regclass('public.doc_counters') is not null as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the numbering migration is already applied to the live database, so this proof can no longer be run here (it passed before it was applied; see the commit message)." >&2; exit 3;; esac
GUARD=$(mktemp); trap 'rm -f "$GUARD"' EXIT
if [ "$MODE" = "guard" ]; then
  printf "%s\n" "select public.next_doc_no('ORDER');" > "$GUARD"      # one number issued: the rollback must refuse (this runs as the owner, inside the rolled-back transaction)
else
  printf "%s\n" "select 1;" > "$GUARD"
fi
exec "$(dirname "$0")/run-sql-tests.sh" NUMBERING_DOWN_PROOF \
  supabase/migrations/20261115100000_customer_shop.sql supabase/migrations/20261115200000_wallet_payments.sql supabase/migrations/20261115300000_online_ordering.sql supabase/migrations/20261115400000_checkout_slip_pickup.sql \
  supabase/tests/checkout_down_pre.sql supabase/migrations/20261115500000_document_numbering.sql "$GUARD" supabase/rollbacks/20261115500000_document_numbering_down.sql supabase/tests/numbering_down_post.sql
