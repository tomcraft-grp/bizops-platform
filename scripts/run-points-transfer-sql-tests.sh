#!/bin/bash
# Points transfer migration + its tests against the live Supabase project in ONE transaction that always rolls back (see run-sql-tests.sh for the guards).
exec "$(dirname "$0")/run-sql-tests.sh" POINTS_TRANSFER_TESTS supabase/migrations/20261127120000_points_transfer.sql supabase/tests/points_transfer.sql
