#!/bin/bash
# Payment integrity migration + its tests against the live Supabase project in ONE transaction that always rolls back (see run-sql-tests.sh for the guards).
exec "$(dirname "$0")/run-sql-tests.sh" PAYMENT_INTEGRITY_TESTS supabase/migrations/20261122120000_finance_payment_integrity.sql supabase/tests/finance_payment_integrity.sql
