#!/bin/bash
# Central receivables migration + its tests against the live Supabase project in ONE transaction that always rolls back (see run-sql-tests.sh for the guards).
exec "$(dirname "$0")/run-sql-tests.sh" CENTRAL_RECEIVABLES_TESTS supabase/migrations/20261122130000_central_receivables.sql supabase/tests/central_receivables.sql
