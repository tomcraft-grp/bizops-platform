#!/bin/bash
# Runs the shop + wallet migrations and the wallet tests against the live Supabase project inside ONE transaction that always
# rolls back (the test file ends by raising an exception that carries the result table), so nothing persists.
# SAFETY: this sends SQL to the production database. It refuses to send anything unless every file exists and the payload really
# ends with that closing rollback. Never concatenate files for production with a bare `cat` (a missing file once made a
# migration commit by accident).
# Needs a Supabase management token in ~/.supabase-token. Usage: scripts/run-wallet-sql-tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
FILES=(supabase/migrations/20261115100000_customer_shop.sql supabase/migrations/20261115200000_wallet_payments.sql supabase/migrations/20261115300000_online_ordering.sql supabase/tests/wallet_payments.sql)
for f in "${FILES[@]}"; do [ -s "$f" ] || { echo "REFUSING TO RUN: $f is missing or empty" >&2; exit 2; }; done
PAYLOAD=$(mktemp); BODY=$(mktemp)
trap 'rm -f "$PAYLOAD" "$BODY"' EXIT
for f in "${FILES[@]}"; do cat "$f" >> "$PAYLOAD"; printf '\n' >> "$PAYLOAD"; done
tail -c 400 "$PAYLOAD" | grep -q "raise exception E'WALLET_TESTS" || { echo "REFUSING TO RUN: the payload does not end with the closing rollback" >&2; exit 2; }
node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({query:fs.readFileSync(process.argv[1],"utf8")}))' "$PAYLOAD" > "$BODY"
TOKEN=$(tr -d '\r\n' < ~/.supabase-token)
curl -s -X POST "https://api.supabase.com/v1/projects/hlvravynjalculvplrxc/database/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "@$BODY" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(String(j.message||s).split("\\n").join("\n"))}catch{console.log(s)}})'
