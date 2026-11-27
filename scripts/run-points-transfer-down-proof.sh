#!/bin/bash
# Proves supabase/rollbacks/20261127120000_points_transfer_down.sql in ONE transaction that always rolls back.
exec "$(dirname "$0")/run-sql-tests.sh" POINTS_TRANSFER_DOWN supabase/tests/points_transfer_down_pre.sql supabase/migrations/20261127120000_points_transfer.sql supabase/rollbacks/20261127120000_points_transfer_down.sql supabase/tests/points_transfer_down_post.sql
