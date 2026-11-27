#!/bin/bash
# Proves supabase/rollbacks/20261122130000_central_receivables_down.sql in ONE transaction that always rolls back.
exec "$(dirname "$0")/run-sql-tests.sh" CENTRAL_RECEIVABLES_DOWN supabase/tests/central_receivables_down_pre.sql supabase/migrations/20261122130000_central_receivables.sql supabase/rollbacks/20261122130000_central_receivables_down.sql supabase/tests/central_receivables_down_post.sql
