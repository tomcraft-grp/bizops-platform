#!/bin/bash
# The expense bank-posting migration and its tests against the live Supabase project in ONE transaction that always rolls back (see run-sql-tests.sh for the guards).
# The migration runs on top of everything already applied; every claim, bank movement, ledger row, role and product the tests write disappears with the rollback.
exec "$(dirname "$0")/run-sql-tests.sh" EXPENSE_BANK_TESTS supabase/migrations/20261128160000_expense_bank_posting.sql supabase/tests/expense_bank_posting.sql
