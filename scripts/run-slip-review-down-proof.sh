#!/bin/bash
# Proves the rollback of the slip-review migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the whole public schema -> migration 20261120100000 -> [guard scenario] -> rollback -> comparison.
#   scripts/run-slip-review-down-proof.sh                       # clean: the rollback must restore the schema exactly (expects "SLIP_REVIEW_DOWN_PROOF n of n passed")
#   scripts/run-slip-review-down-proof.sh guard                 # the rollback must REFUSE once each of six kinds of record exists (analysis, staff_entry, confirmed,
#                                                               #   more_evidence, stamp, cash); expects "SLIP_REVIEW_DOWN_GUARD 6 of 6 refused"
#   scripts/run-slip-review-down-proof.sh guard <kind>          # only one of the six
#   scripts/run-slip-review-down-proof.sh control               # sanity check of the comparison: WITHOUT the rollback it must report differences
# Exit code: 0 = proven, 1 = not proven, 3 = refused to run (the migration is already live, see below).
# Only the new migration is sent: every earlier migration is already live (see scripts/run-slip-review-regression.sh for why older ones cannot be re-sent).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE/.."
MODE="${1:-clean}"; KIND="${2:-}"
MIG=supabase/migrations/20261120100000_slip_review.sql
DOWN=supabase/rollbacks/20261120100000_slip_review_down.sql
# This proof compares the schema before and after "migration + rollback" INSIDE a rolled-back transaction, so it only means something while the
# live database does not have the migration yet. Once it is applied, the "before" snapshot already contains it: refuse instead of reporting nonsense.
APPLIED=$(bash "$HERE/db-readonly.sh" "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_settings' and column_name = 'ai_review_enabled') as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the slip-review migration is already applied to the live database, so this proof can no longer be run here (it was run before it was applied; see docs/slip-review.md)." >&2; exit 3;; esac
case "$APPLIED" in *'"applied":false'*) ;; *) echo "REFUSING: could not tell whether the migration is live: $APPLIED" >&2; exit 3;; esac
GUARD=$(mktemp); OUT=$(mktemp); trap 'rm -f "$GUARD" "$OUT"' EXIT

# A guard scenario: a customer, an invoice and ONE record of the kind the rollback must never destroy (the rows exist only inside this transaction).
guard_sql() {   # kind -> SQL on stdout, and the expected refusal on fd 3 (via the global EXPECT)
  local body
  case "$1" in
    analysis)     EXPECT="Slip analyses exist"
                  body="insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount) values (v_i, v_c, 'down-guard/a', repeat('a', 64), 'image/png', 100) returning id into v_e;
  insert into public.finance_slip_analysis (evidence_id, attempt, status) values (v_e, 1, 'queued');" ;;
    staff_entry)  EXPECT="Payments were recorded, confirmed or sent back"
                  body="insert into public.finance_payment_evidence (invoice_id, customer_id, claimed_amount, source, method) values (v_i, v_c, 100, 'staff_entry', 'cash');" ;;
    confirmed)    EXPECT="Payments were recorded, confirmed or sent back"
                  body="insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status) values (v_i, v_c, 'down-guard/c', repeat('c', 64), 'image/png', 100, 'confirmed');" ;;
    more_evidence) EXPECT="Payments were recorded, confirmed or sent back"
                  body="insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status) values (v_i, v_c, 'down-guard/m', repeat('d', 64), 'image/png', 100, 'more_evidence');" ;;
    stamp)        EXPECT="Payments were recorded, confirmed or sent back"
                  body="insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status, verified_amount, confirmed_by) values (v_i, v_c, 'down-guard/s', repeat('e', 64), 'image/png', 100, 'verified', 100, gen_random_uuid());" ;;
    cash)         EXPECT="Cash receipts are queued for the ledger"
                  body="insert into public.finance_gl_queue (event_type, ref_type, ref_id, ref_no, amount, plan) values ('CASH_RECEIPT', 'receipt', gen_random_uuid(), 'RC-DOWN-GUARD', 100,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'cash', 'amount', 100), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 100)));" ;;
    *) echo "unknown guard kind '$1' (analysis, staff_entry, confirmed, more_evidence, stamp, cash)" >&2; exit 2 ;;
  esac
  cat <<SQL
do \$g\$ declare v_c uuid; v_i uuid; v_e uuid;
begin
  insert into public.finance_customers (code, name) values ('DOWN-GUARD', 'Down guard test') returning id into v_c;
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount) values ('INV-DOWN-GUARD-1', v_c, current_date, current_date, 100) returning id into v_i;
  $body
end \$g\$;
SQL
}

run() {   # runs the payload given as arguments through the always-rolling-back runner; the text of the answer goes to $OUT
  "$HERE/run-sql-tests.sh" "$@" > "$OUT" 2>&1
}
result() { grep -o "SLIP_REVIEW_DOWN_PROOF [0-9]* of [0-9]* passed" "$OUT" | head -n 1; }

case "$MODE" in
  clean)
    printf "%s\n" "select 1;" > "$GUARD"
    run SLIP_REVIEW_DOWN_PROOF supabase/tests/slip_review_down_pre.sql "$MIG" "$GUARD" "$DOWN" supabase/tests/slip_review_down_post.sql
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "NOT PROVEN: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" = "$m" ] && grep -q "^PASS" "$OUT" && ! grep -q "^FAIL" "$OUT"; then echo "PROVEN: the rollback restores the schema exactly ($R)"; exit 0; fi
    echo "NOT PROVEN: $R"; exit 1 ;;
  control)
    printf "%s\n" "select 1;" > "$GUARD"
    run SLIP_REVIEW_DOWN_PROOF supabase/tests/slip_review_down_pre.sql "$MIG" "$GUARD" supabase/tests/slip_review_down_post.sql
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "CONTROL FAILED: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" -lt "$m" ]; then echo "CONTROL OK: without the rollback the comparison finds the difference ($R)"; exit 0; fi
    echo "CONTROL FAILED: the comparison did not notice the migration ($R)"; exit 1 ;;
  guard)
    kinds="analysis staff_entry confirmed more_evidence stamp cash"; [ -n "$KIND" ] && kinds="$KIND"
    ok=0; total=0
    for k in $kinds; do
      guard_sql "$k" > "$GUARD" || exit 2
      total=$((total + 1))
      run SLIP_REVIEW_DOWN_PROOF supabase/tests/slip_review_down_pre.sql "$MIG" "$GUARD" "$DOWN" supabase/tests/slip_review_down_post.sql
      if grep -qF "$EXPECT" "$OUT" && ! grep -q "SLIP_REVIEW_DOWN_PROOF" "$OUT"; then
        echo "REFUSED [$k]: $(grep -F "$EXPECT" "$OUT" | head -n 1 | cut -c1-200)"; ok=$((ok + 1))
      else
        echo "NOT REFUSED [$k] (expected: $EXPECT):"; cut -c1-300 "$OUT" | head -n 6
      fi
    done
    echo "SLIP_REVIEW_DOWN_GUARD $ok of $total refused"
    [ "$ok" = "$total" ] && exit 0 || exit 1 ;;
  *) echo "usage: $0 [clean | control | guard [analysis|staff_entry|confirmed|more_evidence|stamp|cash]]" >&2; exit 2 ;;
esac
