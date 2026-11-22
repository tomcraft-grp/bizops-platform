#!/bin/bash
# Proves supabase/rollbacks/20261122120000_finance_payment_integrity_down.sql in ONE transaction that always rolls back.
exec "$(dirname "$0")/run-sql-tests.sh" PAYMENT_INTEGRITY_DOWN supabase/tests/finance_payment_integrity_down_pre.sql supabase/migrations/20261122120000_finance_payment_integrity.sql supabase/rollbacks/20261122120000_finance_payment_integrity_down.sql supabase/tests/finance_payment_integrity_down_post.sql
