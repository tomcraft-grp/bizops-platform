#!/bin/bash
# The delivery-pin migration and its tests against the live Supabase project in ONE transaction that always rolls back (see run-sql-tests.sh for the guards).
# The migration runs on top of everything already applied; every order, saved address and setting the tests touch disappears with the rollback.
exec "$(dirname "$0")/run-sql-tests.sh" DELIVERY_PIN_TESTS supabase/migrations/20261128130000_delivery_pin.sql supabase/tests/delivery_pin.sql
