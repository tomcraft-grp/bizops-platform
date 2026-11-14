#!/bin/bash
# Read-only query against the live Supabase project (inspection / post-deploy verification). Refuses anything that is not a single
# SELECT / WITH ... SELECT, or that contains a word that could change data or schema. The token is read from ~/.supabase-token and never printed.
#   scripts/db-readonly.sh "select count(*) from public.finance_wallets"
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 \"<select ...>\"" >&2; exit 2; }
SQL="$1"
printf '%s' "$SQL" | grep -Eiq '^[[:space:]]*(select|with)[[:space:]]' || { echo "REFUSING: not a SELECT" >&2; exit 2; }
if printf '%s' "$SQL" | sed -E 's/;[[:space:]]*$//' | grep -q ';'; then echo "REFUSING: more than one statement" >&2; exit 2; fi
if printf '%s' "$SQL" | grep -Eiq '\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|vacuum|copy|call|do|set_config|pg_terminate_backend|pg_cancel_backend|nextval|setval)\b'; then echo "REFUSING: contains a word that can change data or schema" >&2; exit 2; fi
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
node -e 'process.stdout.write(JSON.stringify({query:process.argv[1],read_only:true}))' "$SQL" > "$BODY"
TOKEN=$(tr -d '\r\n' < ~/.supabase-token)
curl -s -X POST "https://api.supabase.com/v1/projects/hlvravynjalculvplrxc/database/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "@$BODY"
echo
