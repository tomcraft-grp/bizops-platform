#!/bin/bash
# The LINE card map migration and its tests against the live Supabase project in ONE transaction that always rolls back (see run-sql-tests.sh for the guards).
# Only this migration is sent: every earlier one (including the delivery pin) is already live.
exec "$(dirname "$0")/run-sql-tests.sh" LINE_CARD_MAP_TESTS supabase/migrations/20261128140000_line_card_map.sql supabase/tests/line_card_map.sql
