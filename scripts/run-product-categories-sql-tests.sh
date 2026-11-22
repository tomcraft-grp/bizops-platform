#!/bin/bash
# Product categories: snapshot of what the shop shows -> the migration -> the tests, against the live Supabase project in ONE transaction that always rolls back
# (the test file ends by raising an exception that carries the result table). See run-sql-tests.sh for the guards.
exec "$(dirname "$0")/run-sql-tests.sh" PRODUCT_CATEGORY_TESTS supabase/tests/product_categories_pre.sql supabase/migrations/20261122110000_product_categories.sql supabase/tests/product_categories.sql
