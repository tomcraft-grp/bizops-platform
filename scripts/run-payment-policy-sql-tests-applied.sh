#!/bin/bash
# The payment policy + wallet QR tests against the LIVE functions, AFTER migrations 20261127100000 and 20261127110000 were applied (no migration text in the payload).
# One transaction that always rolls back, so nothing persists (see run-sql-tests.sh for the guards).
exec "$(dirname "$0")/run-sql-tests.sh" PAYMENT_POLICY_TESTS supabase/tests/payment_policy.sql
