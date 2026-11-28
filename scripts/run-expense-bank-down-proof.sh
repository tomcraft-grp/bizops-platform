#!/bin/bash
# Proves the rollback of the expense bank-posting migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the whole public schema + the expense / bank rows -> migration 20261128160000 -> rollback -> comparison.
#   scripts/run-expense-bank-down-proof.sh            # clean: the rollback must restore schema and rows exactly (expects "EXPENSE_BANK_DOWN_PROOF n of n passed")
#   scripts/run-expense-bank-down-proof.sh control    # sanity check of the comparison: WITHOUT the rollback it must report differences
#   scripts/run-expense-bank-down-proof.sh guard      # the rollback must REFUSE once an expense was posted with a bank movement
# Exit code: 0 = proven, 1 = not proven, 3 = refused to run (the migration is already live).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE/.."
MODE="${1:-clean}"
PRE=supabase/tests/slip_review_down_pre.sql
PRE2=supabase/tests/expense_bank_posting_down_pre.sql
MIG=supabase/migrations/20261128160000_expense_bank_posting.sql
DOWN=supabase/rollbacks/20261128160000_expense_bank_posting_down.sql
POST=supabase/tests/expense_bank_posting_down_post.sql
APPLIED=$(bash "$HERE/db-readonly.sh" "select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'finance_bank_transactions') as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the expense bank-posting migration is already applied to the live database, so this proof can no longer be run here (see docs/expense-bank-posting.md)." >&2; exit 3;; esac
case "$APPLIED" in *'"applied":false'*) ;; *) echo "REFUSING: could not tell whether the migration is live: $APPLIED" >&2; exit 3;; esac

GUARD=$(mktemp); OUT=$(mktemp); trap 'rm -f "$GUARD" "$OUT"' EXIT
run() { "$HERE/run-sql-tests.sh" "$@" > "$OUT" 2>&1; }
result() { grep -o "EXPENSE_BANK_DOWN_PROOF [0-9]* of [0-9]* passed" "$OUT" | head -n 1; }

case "$MODE" in
  clean)
    printf "%s\n" "select 1;" > "$GUARD"
    run EXPENSE_BANK_DOWN_PROOF "$PRE" "$PRE2" "$MIG" "$GUARD" "$DOWN" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "NOT PROVEN: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" = "$m" ] && grep -q "PASS" "$OUT" && ! grep -q "FAIL \[" "$OUT"; then echo "PROVEN: the rollback restores the schema and rows exactly ($R)"; exit 0; fi
    echo "NOT PROVEN: $R"; exit 1 ;;
  control)
    printf "%s\n" "select 1;" > "$GUARD"
    run EXPENSE_BANK_DOWN_PROOF "$PRE" "$PRE2" "$MIG" "$GUARD" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "CONTROL FAILED: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" -lt "$m" ]; then echo "CONTROL OK: without the rollback the comparison finds the difference ($R)"; exit 0; fi
    echo "CONTROL FAILED: the comparison did not notice the migration ($R)"; exit 1 ;;
  guard)
    cat > "$GUARD" <<'SQL'
-- the admin records one bank-transfer expense and approves & posts it (a real bank movement)
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1), 'role', 'authenticated')::text, true);
select public.expense_post_bulk(array[(public.expense_save(null, (now() at time zone 'Asia/Bangkok')::date, (select id from public.expense_categories where code = 'office_supplies'), 'Guard', 10, 'none', 'bank_transfer',
  null, null, null, null, null, (select id from public.finance_bank_accounts where code = 'SCB'))).id]);
SQL
    run EXPENSE_BANK_DOWN_PROOF "$PRE" "$PRE2" "$MIG" "$GUARD" "$DOWN" "$POST"
    if grep -qF "REFUSING:" "$OUT" && ! grep -q "EXPENSE_BANK_DOWN_PROOF" "$OUT"; then
      echo "REFUSED: $(grep -F "REFUSING" "$OUT" | head -n 1 | cut -c1-220)"; echo "EXPENSE_BANK_DOWN_GUARD 1 of 1 refused"; exit 0
    fi
    echo "NOT REFUSED:"; cut -c1-300 "$OUT" | head -n 8; echo "EXPENSE_BANK_DOWN_GUARD 0 of 1 refused"; exit 1 ;;
  *) echo "usage: $0 [clean | control | guard]" >&2; exit 2 ;;
esac
