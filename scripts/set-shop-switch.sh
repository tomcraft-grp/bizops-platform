#!/bin/bash
# Flips ONE switch of the online shop on the LIVE project: the same switches as Online shop -> Settings. It changes only that column (and updated_at),
# refuses any other name, and prints the settings before and after. Nothing else is touched.
#   scripts/set-shop-switch.sh pickup_enabled on        scripts/set-shop-switch.sh require_payment_slip off
#   names: shop_open | delivery_enabled | pickup_enabled | require_payment_slip
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in shop_open|delivery_enabled|pickup_enabled|require_payment_slip) COL="$1";; *) echo "usage: $0 shop_open|delivery_enabled|pickup_enabled|require_payment_slip on|off" >&2; exit 2;; esac
case "${2:-}" in on) V=true;; off) V=false;; *) echo "usage: $0 $COL on|off" >&2; exit 2;; esac
if [ "$COL" = "require_payment_slip" ]; then
  has=$(bash scripts/db-readonly.sh "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'shop_settings' and column_name = 'require_payment_slip') as ok")
  case "$has" in *'"ok":true'*) ;; *) echo "REFUSING: the checkout migration is not applied yet." >&2; exit 3;; esac
fi
SHOW="select shop_open, delivery_enabled, pickup_enabled, shipping_fee, coalesce(pickup_note, '') as pickup_note from public.shop_settings"
echo "before: $(bash scripts/db-readonly.sh "$SHOW")"
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
node -e 'process.stdout.write(JSON.stringify({query:"update public.shop_settings set " + process.argv[1] + " = " + process.argv[2] + ", updated_at = now() where id;"}))' "$COL" "$V" > "$BODY"
TOKEN=$(tr -d '\r\n' < ~/.supabase-token)
RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/hlvravynjalculvplrxc/database/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "@$BODY")
echo "result: $RESULT"
AFTER=$(bash scripts/db-readonly.sh "$SHOW")
echo "after:  $AFTER"
case "$AFTER" in *"\"$COL\":$V"*) echo "DONE: $COL is now $2";; *) if [ "$COL" = "require_payment_slip" ]; then v2=$(bash scripts/db-readonly.sh "select require_payment_slip from public.shop_settings"); case "$v2" in *"\"require_payment_slip\":$V"*) echo "DONE: $COL is now $2";; *) echo "FAILED" >&2; exit 1;; esac; else echo "FAILED: the switch did not change" >&2; exit 1; fi;; esac
