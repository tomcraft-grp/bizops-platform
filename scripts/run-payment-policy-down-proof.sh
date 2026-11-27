#!/bin/bash
# Proves the rollbacks of 20261127100000 (payment policy) and 20261127110000 (deposit QR) in ONE transaction that always rolls back.
exec "$(dirname "$0")/run-sql-tests.sh" PAYMENT_POLICY_DOWN supabase/tests/payment_policy_down_pre.sql supabase/migrations/20261127100000_customer_payment_policy.sql supabase/migrations/20261127110000_wallet_deposit_qr.sql supabase/rollbacks/20261127110000_wallet_deposit_qr_down.sql supabase/rollbacks/20261127100000_customer_payment_policy_down.sql supabase/tests/payment_policy_down_post.sql
