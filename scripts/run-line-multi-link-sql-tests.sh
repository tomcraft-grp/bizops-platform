#!/bin/bash
# The LINE multi-link migration (several LINE accounts per staff account, a code never removes another person) and its tests against the live project in ONE transaction that always rolls back
# (see run-sql-tests.sh for the guards). Only this migration is sent: every earlier one is already live.
exec "$(dirname "$0")/run-sql-tests.sh" LINE_MULTI_LINK_TESTS supabase/migrations/20261128120000_line_multi_link.sql supabase/tests/line_multi_link.sql
