#!/bin/bash
# The back-office access migration (a SUPER_ADMIN gives / takes back the ADMIN role of a LINE member) and its tests against the live project in ONE transaction that always rolls back
# (see run-sql-tests.sh for the guards). Only this migration is sent: every earlier one is already live.
exec "$(dirname "$0")/run-sql-tests.sh" BACKOFFICE_ACCESS_TESTS supabase/migrations/20261128110000_backoffice_access.sql supabase/tests/backoffice_access.sql
