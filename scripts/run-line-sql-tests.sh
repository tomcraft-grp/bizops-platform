#!/bin/bash
# Runs the LINE OA order-notification migration and its tests against the live Supabase project inside ONE transaction that always rolls back
# (the test file ends by raising an exception that carries the result table), so nothing persists, not even the new tables, extensions or Vault secrets.
# The ADMIN prelude promotes one real member to ADMIN inside the same transaction (the live project has no ADMIN). Only the new migration is sent:
# every earlier migration is already live. It refuses to send anything unless every file exists and the payload ends with the closing rollback.
exec "$(dirname "$0")/run-sql-tests.sh" LINE_TESTS supabase/tests/prod_dry_run_prelude.sql supabase/migrations/20261122140000_line_order_notifications.sql supabase/tests/line_notifications.sql
