#!/bin/bash
# Runs the feedback closure-tracking migration and its tests against the live Supabase project inside ONE transaction that always rolls back
# (the test file ends by raising an exception that carries the result table), so nothing persists. See run-sql-tests.sh for the guards.
exec "$(dirname "$0")/run-sql-tests.sh" FEEDBACK_CLOSURE_TESTS supabase/migrations/20261122100000_feedback_closure_tracking.sql supabase/tests/feedback_closure.sql
