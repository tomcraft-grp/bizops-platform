#!/bin/bash
# Runs the feedback English-context migration and its tests against the live Supabase project inside ONE transaction that always rolls back
# (the test file ends by raising an exception that carries the result table), so nothing persists.
# It refuses to send anything unless every file exists and the payload really ends with that closing rollback (see run-sql-tests.sh).
exec "$(dirname "$0")/run-sql-tests.sh" FEEDBACK_CTX_TESTS supabase/migrations/20261115600000_feedback_english_context.sql supabase/migrations/20261115610000_feedback_english_context_limits.sql supabase/tests/feedback_english_context.sql
