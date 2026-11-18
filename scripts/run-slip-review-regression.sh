#!/bin/bash
# Regression for the slip-review migration: runs the three EXISTING SQL suites (online ordering, wallet payments, customer shop) twice each against the live
# Supabase project, once as they are today ("before") and once with 20261120100000_slip_review.sql sent first ("with"), and fails when a check that passes before
# fails with the migration, when a run gives no result, or when the number of checks changes. So every existing check also runs against the replaced functions
# (finance_verify_evidence, finance_reject_evidence, finance_reverse_receipt, finance_invoice_state_raw, shop_cancel_order_internal, the two reports).
# Every run is its own transaction that ALWAYS rolls back (scripts/run-sql-tests.sh refuses to send anything unless the payload ends with the closing rollback).
#
# Why only the new migration is sent, and why "before" is a baseline: every earlier migration is already live, and re-sending them cannot work any more
# (20261115500000_document_numbering.sql rewrites functions from their live text and stops with "numbering swap: expected 1 function(s) ... found 0" when it
# is sent again, and the older migrations would bring back function bodies that use the sequences that migration dropped). Also, the existing suites were written
# for an empty database: production now holds real orders, wallets and ledger rows, so a few of their checks fail (or abort) with or without the new
# migration, for example "customer B has no orders" (B has real ones). The comparison before / with shows that the migration changes none of them.
# The wallet suite even aborts before its first section is over (three single-row subqueries on finance_gl_queue see the real rows): for it, a temporary copy
# is used in which those three subqueries take the newest queue row of their event type (the row the test has just made); the copy is used for both runs and no
# file under supabase/tests is changed.
cd "$(dirname "$0")/.." || exit 2
NEW="supabase/migrations/20261120100000_slip_review.sql"
RUNNER="$(pwd)/scripts/run-sql-tests.sh"
[ -s "$NEW" ] || { echo "missing $NEW" >&2; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
status=0

sed -E "s/from public\.finance_gl_queue q where q\.event_type = '(WALLET_DEPOSIT|BANK_RECEIPT|WALLET_REFUND)'\), null;/from public.finance_gl_queue q where q.event_type = '\1' order by q.seq desc limit 1), null;/" supabase/tests/wallet_payments.sql > "$TMP/wallet_payments.sql"
[ "$(grep -c 'order by q.seq desc limit 1' "$TMP/wallet_payments.sql")" = 3 ] || { echo "the wallet suite no longer has the three queue look-ups this script scopes; update the script" >&2; exit 2; }

names() { grep -E "^$2 " "$1" | sed -E "s/^(PASS|FAIL) \[[0-9]+\] //; s/ => .*//" | sort; }       # file, PASS|FAIL
run_suite() {   # marker, test file, label
  local marker="$1" tests="$2" label="$3" sb sw nb mb nw mw
  "$RUNNER" "$marker" "$tests" > "$TMP/$label.before" 2>&1
  "$RUNNER" "$marker" "$NEW" "$tests" > "$TMP/$label.with" 2>&1
  sb=$(grep -o "$marker [0-9]* of [0-9]* passed" "$TMP/$label.before" | head -n 1)
  sw=$(grep -o "$marker [0-9]* of [0-9]* passed" "$TMP/$label.with" | head -n 1)
  echo "$label before: ${sb:-NO RESULT}"
  echo "$label with the migration: ${sw:-NO RESULT}"
  if [ -z "$sb" ] || [ -z "$sw" ]; then
    echo "  $label: a run gave no result"; head -n 3 "$TMP/$label.before" | cut -c1-300; head -n 3 "$TMP/$label.with" | cut -c1-300; status=1; return
  fi
  nb=$(echo "$sb" | awk '{print $2}'); mb=$(echo "$sb" | awk '{print $4}'); nw=$(echo "$sw" | awk '{print $2}'); mw=$(echo "$sw" | awk '{print $4}')
  [ "$mb" = "$mw" ] || { echo "  $label: the number of checks changed ($mb before, $mw with)"; status=1; }
  # a check that passed before and does not pass with the migration is a regression
  comm -23 <(names "$TMP/$label.before" PASS) <(names "$TMP/$label.with" PASS) > "$TMP/$label.regressions"
  if [ -s "$TMP/$label.regressions" ]; then
    echo "  $label: REGRESSION, these checks passed before and fail with the migration:"; sed 's/^/    /' "$TMP/$label.regressions" | cut -c1-300; status=1
  else
    echo "  $label: no check that passed before fails with the migration ($((mb - nb)) checks fail both before and with the migration)"
  fi
}
run_suite ORDERING_TESTS supabase/tests/online_ordering.sql ordering
run_suite WALLET_TESTS "$TMP/wallet_payments.sql" wallet
run_suite SHOP_TESTS supabase/tests/customer_shop.sql shop
if [ "$status" = 0 ]; then echo "REGRESSION OK"; else echo "REGRESSION FAILED"; fi
exit "$status"
