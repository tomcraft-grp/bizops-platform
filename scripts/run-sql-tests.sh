#!/bin/bash
# Generic guarded runner: sends the given SQL files to the live Supabase project as ONE transaction that must end with a forced
# rollback. It refuses unless every file exists and the payload's tail contains the closing-rollback marker.
#   scripts/run-sql-tests.sh <MARKER> <file> [<file> ...]      e.g.  scripts/run-sql-tests.sh SHOP_TESTS a.sql b.sql tests/shop.sql
# The last file must end with:  raise exception E'<MARKER> ...'   (the test files in supabase/tests do).
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -ge 2 ] || { echo "usage: $0 <MARKER> <file>..." >&2; exit 2; }
MARK="$1"; shift
for f in "$@"; do [ -s "$f" ] || { echo "REFUSING TO RUN: $f is missing or empty" >&2; exit 2; }; done
PAYLOAD=$(mktemp); BODY=$(mktemp)
trap 'rm -f "$PAYLOAD" "$BODY"' EXIT
for f in "$@"; do cat "$f" >> "$PAYLOAD"; printf '\n' >> "$PAYLOAD"; done
tail -c 600 "$PAYLOAD" | grep -q "raise exception E'$MARK" || { echo "REFUSING TO RUN: the payload does not end with the closing rollback ($MARK)" >&2; exit 2; }
node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({query:fs.readFileSync(process.argv[1],"utf8")}))' "$PAYLOAD" > "$BODY"
TOKEN=$(tr -d '\r\n' < ~/.supabase-token)
curl -s -X POST "https://api.supabase.com/v1/projects/hlvravynjalculvplrxc/database/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "@$BODY" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(String(j.message||s).split("\\n").join("\n"))}catch{console.log(s)}})'
