#!/bin/bash
# Switches the online shop on or off on the LIVE project: the same switch as Online shop -> Settings -> "The shop takes online orders".
# It changes ONLY shop_settings.shop_open (and its updated_at), refuses unless the shop can really take orders (at least one active bank account
# or payment account), and prints the state before and after. Nothing else is touched.
#   scripts/set-shop-open.sh on      scripts/set-shop-open.sh off
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in on) V=true;; off) V=false;; *) echo "usage: $0 on|off" >&2; exit 2;; esac
before=$(bash scripts/db-readonly.sh "select shop_open, delivery_enabled, pickup_enabled, shipping_fee from public.shop_settings")
echo "before: $before"
if [ "$V" = "true" ]; then
  ready=$(bash scripts/db-readonly.sh "select (exists (select 1 from public.finance_bank_accounts where active) or exists (select 1 from public.finance_payment_accounts where active and is_default)) as ready")
  case "$ready" in *'"ready":true'*) ;; *) echo "REFUSING: no active bank account or payment account: customers could not pay." >&2; exit 3;; esac
  fn=$(bash scripts/db-readonly.sh "select to_regprocedure('public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text)') is not null as ok")
  case "$fn" in *'"ok":true'*) ;; *) echo "REFUSING: the online-ordering migration is not applied yet." >&2; exit 3;; esac
fi
SQL="update public.shop_settings set shop_open = $V, updated_at = now() where id;"
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
node -e 'process.stdout.write(JSON.stringify({query:process.argv[1]}))' "$SQL" > "$BODY"
TOKEN=$(tr -d '\r\n' < ~/.supabase-token)
RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/hlvravynjalculvplrxc/database/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "@$BODY")
echo "result: $RESULT"
after=$(bash scripts/db-readonly.sh "select shop_open, delivery_enabled, pickup_enabled, shipping_fee from public.shop_settings")
echo "after:  $after"
case "$after" in *"\"shop_open\":$V"*) echo "DONE: shop is now $1";; *) echo "FAILED: the switch did not change" >&2; exit 1;; esac
