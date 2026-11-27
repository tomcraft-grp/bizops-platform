#!/bin/bash
# Payment policy + wallet deposit QR migrations and their tests against the live Supabase project in ONE transaction that always rolls back (see run-sql-tests.sh for the guards).
exec "$(dirname "$0")/run-sql-tests.sh" PAYMENT_POLICY_TESTS supabase/migrations/20261127100000_customer_payment_policy.sql supabase/migrations/20261127110000_wallet_deposit_qr.sql supabase/tests/payment_policy.sql
