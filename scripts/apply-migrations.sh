#!/bin/bash
# Applies migration files to the LIVE Supabase project in ONE transaction (all or nothing) and records each in
# supabase_migrations.schema_migrations, like the earlier hand-applied migrations. Meant to be run deliberately, after the SQL suites passed.
#   scripts/apply-migrations.sh <version>:<name>:<file> [<version>:<name>:<file> ...]
#   e.g. scripts/apply-migrations.sh 20261115100000:customer_shop:supabase/migrations/20261115100000_customer_shop.sql
# Refuses (and sends nothing) unless: every file exists and is non-empty, every version looks like a timestamp, none of the versions is
# already recorded, and the migration text can be quoted safely. The token is read from ~/.supabase-token and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -ge 1 ] || { echo "usage: $0 <version>:<name>:<file> ..." >&2; exit 2; }
VERSIONS=""
for spec in "$@"; do
  v="${spec%%:*}"; rest="${spec#*:}"; n="${rest%%:*}"; f="${rest#*:}"
  [[ "$v" =~ ^[0-9]{14}$ ]] || { echo "REFUSING: bad version '$v'" >&2; exit 2; }
  [[ "$n" =~ ^[a-z0-9_]+$ ]] || { echo "REFUSING: bad name '$n'" >&2; exit 2; }
  [ -s "$f" ] || { echo "REFUSING: $f is missing or empty" >&2; exit 2; }
  VERSIONS="${VERSIONS:+$VERSIONS,}'$v'"
done
RECORDED=$(bash scripts/db-readonly.sh "select version from supabase_migrations.schema_migrations where version in ($VERSIONS)")
[ "$RECORDED" = "[]" ] || { echo "REFUSING: already recorded: $RECORDED" >&2; exit 2; }
PAYLOAD=$(mktemp); BODY=$(mktemp); trap 'rm -f "$PAYLOAD" "$BODY"' EXIT
node -e '
const fs = require("fs");
let sql = "";
for (const spec of process.argv.slice(1)) {
  const i = spec.indexOf(":"), j = spec.indexOf(":", i + 1);
  const version = spec.slice(0, i), name = spec.slice(i + 1, j), file = spec.slice(j + 1);
  const text = fs.readFileSync(file, "utf8");
  const tag = "$mig_" + version + "$";
  if (text.includes(tag)) throw new Error("quote tag collision in " + file);
  sql += text.replace(/\s*$/, "\n") + "\n";
  sql += "insert into supabase_migrations.schema_migrations (version, name, statements, created_by) values (\x27" + version + "\x27, \x27" + name + "\x27, array[" + tag + text + tag + "]::text[], \x27claude-code\x27);\n";
}
process.stdout.write(JSON.stringify({ query: sql }));
' "$@" > "$BODY"
[ -s "$BODY" ] || { echo "REFUSING: could not build the payload" >&2; exit 2; }
if [ "${DRY_RUN:-}" = "1" ]; then echo "DRY RUN: payload of $(wc -c < "$BODY") bytes built for: $*; nothing sent"; exit 0; fi
TOKEN=$(tr -d '\r\n' < ~/.supabase-token)
echo "Applying: $*"
RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/hlvravynjalculvplrxc/database/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "@$BODY")
echo "$RESULT" | head -c 2000; echo
case "$RESULT" in "[]"*|"[{"*) echo "APPLIED";; *) echo "FAILED: nothing was committed (one transaction)" >&2; exit 1;; esac
