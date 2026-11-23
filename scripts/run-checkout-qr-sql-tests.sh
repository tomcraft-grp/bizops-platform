#!/bin/bash
# Runs the checkout QR migration and its tests against the live Supabase project inside ONE transaction that always rolls back
# (the test file ends by raising an exception that carries the result table), so nothing persists, not even the new function.
# It refuses to send anything unless every file exists and the payload really ends with that closing rollback (see run-sql-tests.sh).
exec "$(dirname "$0")/run-sql-tests.sh" CHECKOUT_QR_TESTS supabase/migrations/20261123100000_checkout_qr.sql supabase/tests/checkout_qr.sql
