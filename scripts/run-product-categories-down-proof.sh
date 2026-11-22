#!/bin/bash
# Proves supabase/rollbacks/20261122110000_product_categories_down.sql: snapshot -> migration -> rollback -> checks, in ONE transaction that always rolls back.
exec "$(dirname "$0")/run-sql-tests.sh" PRODUCT_CATEGORY_DOWN supabase/tests/product_categories_pre.sql supabase/migrations/20261122110000_product_categories.sql supabase/rollbacks/20261122110000_product_categories_down.sql supabase/tests/product_categories_down_post.sql
