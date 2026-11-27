#!/bin/bash
# The preorder migration and its tests against the live Supabase project in ONE transaction that always rolls back (see run-sql-tests.sh for the guards).
# The migration runs on top of everything already applied; every order, notice, queue row and setting the tests touch disappears with the rollback.
exec "$(dirname "$0")/run-sql-tests.sh" PREORDERS_TESTS supabase/migrations/20261128100000_preorders.sql supabase/tests/preorders.sql
