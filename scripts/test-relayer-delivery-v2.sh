#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/neoos-delivery-pg.XXXXXX")
cleanup() { pg_ctl -D "$test_dir/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$test_dir"; }
trap cleanup EXIT
initdb -D "$test_dir/data" -A trust --no-locale >/dev/null
pg_ctl -D "$test_dir/data" -l "$test_dir/server.log" -o "-k $test_dir -h '' -p 56449" -w start >/dev/null
export PGHOST="$test_dir" PGPORT=56449 PGDATABASE=postgres PGUSER="$(id -un)"
psql -X -v ON_ERROR_STOP=1 -q -c 'create role service_role bypassrls; create role anon; alter default privileges in schema public grant execute on functions to anon;'
psql -X -v ON_ERROR_STOP=1 -q -f "$repo/supabase/migrations/20260908040427_relayer_delivery_v2.sql"
psql -X -v ON_ERROR_STOP=1 -q -f "$repo/tests/relayer-delivery-v2.sql"
psql -X -v ON_ERROR_STOP=1 -q -c "select morpheus_delivery_enqueue('testnet','neox','0x01','99','race-account','{\"requestId\":\"99\"}');" >/dev/null
psql -X -v ON_ERROR_STOP=1 -At -c "select morpheus_delivery_claim('testnet','neox','race-account','race-A',60000);" >"$test_dir/a" &
pid_a=$!
psql -X -v ON_ERROR_STOP=1 -At -c "select morpheus_delivery_claim('testnet','neox','race-account','race-B',60000);" >"$test_dir/b" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
python3 - "$test_dir/a" "$test_dir/b" <<'PY'
import pathlib, sys, json
claims=[pathlib.Path(p).read_text().strip() for p in sys.argv[1:]]
assert sum(bool(v) for v in claims)==1, claims
assert json.loads(next(v for v in claims if v))['generation']==1
print('PASS: PostgreSQL delivery transitions and two-session account claim race')
PY
