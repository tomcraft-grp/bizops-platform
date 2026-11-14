#!/bin/bash
# Proves the wallet rollback script inside ONE transaction that always rolls back (nothing persists):
#   shop migration -> schema fingerprint -> wallet migration -> [guard scenario: an extra bank account] -> rollback -> comparison.
#   scripts/run-wallet-down-proof.sh           # the rollback must restore the schema exactly (expects "WALLET_DOWN_PROOF n of n passed")
#   scripts/run-wallet-down-proof.sh guard     # the rollback must REFUSE because a bank account was added (expects the refusal message)
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-clean}"
GUARD=$(mktemp); trap 'rm -f "$GUARD"' EXIT
if [ "$MODE" = "guard" ]; then
  printf "%s\n" "insert into public.finance_bank_accounts (code, bank_name_en, bank_name_th, account_no, account_name, sort_order) values ('KBANK', 'Kasikornbank', 'ธนาคารกสิกรไทย', '1234567890', 'Guard test', 99);" > "$GUARD"
else
  printf "%s\n" "select 1;" > "$GUARD"
fi
exec "$(dirname "$0")/run-sql-tests.sh" WALLET_DOWN_PROOF \
  supabase/migrations/20261115100000_customer_shop.sql supabase/tests/wallet_down_pre.sql supabase/migrations/20261115200000_wallet_payments.sql \
  "$GUARD" supabase/rollbacks/20261115200000_wallet_payments_down.sql supabase/tests/wallet_down_post.sql
