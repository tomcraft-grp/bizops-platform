#!/bin/bash
# Runs the "no brand" filter migration and its tests against the live Supabase project inside ONE transaction that always rolls back
# (the test file ends by raising an exception that carries the result table), so nothing persists, not even the two replaced functions.
# It refuses to send anything unless every file exists and the payload really ends with that closing rollback (see run-sql-tests.sh).
exec "$(dirname "$0")/run-sql-tests.sh" SHOP_NO_BRAND_TESTS supabase/migrations/20261119100000_shop_no_brand_filter.sql supabase/tests/shop_no_brand.sql
