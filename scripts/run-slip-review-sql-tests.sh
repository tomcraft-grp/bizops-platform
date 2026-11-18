#!/bin/bash
# Runs the slip-review migration and its tests against the live Supabase project inside ONE transaction that always rolls back
# (the test file ends by raising an exception that carries the result table), so nothing persists, not even the new tables and columns.
# Only the new migration is sent: every earlier migration is already live. It refuses to send anything unless every file exists and the
# payload really ends with that closing rollback (see run-sql-tests.sh).
exec "$(dirname "$0")/run-sql-tests.sh" SLIPREVIEW_TESTS supabase/migrations/20261120100000_slip_review.sql supabase/tests/slip_review.sql
