#!/bin/bash
# Runs the customer-shop migration + tests against the live Supabase project inside ONE transaction that always rolls back:
# the test file ends by raising an exception that carries the result table, so nothing persists.
# SAFETY: this sends SQL to the production database, so it refuses to send anything unless BOTH files exist and the payload
# really ends with that closing rollback. (Once, a missing file made a similar ad-hoc command send the migration alone, which
# committed it; never run the migration against production without the closing rollback.)
# Needs a Supabase management token in ~/.supabase-token. Usage: scripts/run-shop-sql-tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
MIG=supabase/migrations/20261115100000_customer_shop.sql
MIG2=supabase/migrations/20261115200000_wallet_payments.sql
MIG3=supabase/migrations/20261115300000_online_ordering.sql
TST=supabase/tests/customer_shop.sql
for f in "$MIG" "$MIG2" "$MIG3" "$TST"; do [ -s "$f" ] || { echo "REFUSING TO RUN: $f is missing or empty" >&2; exit 2; }; done
PAYLOAD=$(mktemp); BODY=$(mktemp)
trap 'rm -f "$PAYLOAD" "$BODY"' EXIT
for f in "$MIG" "$MIG2" "$MIG3" "$TST"; do cat "$f" >> "$PAYLOAD"; printf "
" >> "$PAYLOAD"; done   # all three migrations, in order: the later ones replace functions of the earlier ones
tail -c 400 "$PAYLOAD" | grep -q "raise exception E'SHOP_TESTS" || { echo "REFUSING TO RUN: the payload does not end with the closing rollback" >&2; exit 2; }
node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({query:fs.readFileSync(process.argv[1],"utf8")}))' "$PAYLOAD" > "$BODY"
TOKEN=$(tr -d '\r\n' < ~/.supabase-token)
curl -s -X POST "https://api.supabase.com/v1/projects/hlvravynjalculvplrxc/database/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "@$BODY" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(String(j.message||s).split("\\n").join("\n"))}catch{console.log(s)}})'
