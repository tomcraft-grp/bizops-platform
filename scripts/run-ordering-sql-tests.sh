#!/bin/bash
# Runs the shop / wallet / ordering / checkout migrations and the online-ordering journey tests against the live Supabase project inside ONE
# transaction that always rolls back (the test file ends by raising an exception that carries the result table), so nothing persists.
# It refuses to send anything unless every file exists and the payload really ends with that closing rollback (see run-sql-tests.sh).
exec "$(dirname "$0")/run-sql-tests.sh" ORDERING_TESTS \
  supabase/migrations/20261115100000_customer_shop.sql supabase/migrations/20261115200000_wallet_payments.sql \
  supabase/migrations/20261115300000_online_ordering.sql supabase/migrations/20261115400000_checkout_slip_pickup.sql \
  supabase/tests/online_ordering.sql
