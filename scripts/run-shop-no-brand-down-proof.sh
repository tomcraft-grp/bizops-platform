#!/bin/bash
# Proves the rollback of the "no brand" filter migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of every public function / table / column / policy -> migration 20261119100000 -> its rollback -> comparison.
#   scripts/run-shop-no-brand-down-proof.sh          # expects "SHOP_NO_BRAND_DOWN_PROOF n of n passed"
set -euo pipefail
cd "$(dirname "$0")/.."
# Meaningful only while the migration is not applied yet (otherwise the "before" snapshot already contains it).
APPLIED=$(bash "$(dirname "$0")/db-readonly.sh" "select pg_get_functiondef('public.shop_facets()'::regprocedure) like '%no_brand_count%' as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the no-brand migration is already applied to the live database, so this proof can no longer be run here." >&2; exit 3;; esac
exec "$(dirname "$0")/run-sql-tests.sh" SHOP_NO_BRAND_DOWN_PROOF \
  supabase/tests/shop_brand_down_pre.sql supabase/migrations/20261119100000_shop_no_brand_filter.sql \
  supabase/rollbacks/20261119100000_shop_no_brand_filter_down.sql supabase/tests/shop_brand_down_post.sql
