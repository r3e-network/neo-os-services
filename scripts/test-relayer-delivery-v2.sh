#!/usr/bin/env bash
set -euo pipefail
# macOS CoreFoundation locale loading forks a thread inside the postmaster when the
# inherited LANG/LC_* names a system locale; PostgreSQL then aborts with "postmaster
# became multithreaded during startup". The evidence database is created with
# --no-locale, so the C locales are both sufficient and reproducible.
export LC_ALL=C.UTF-8
repo=$(cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/neoos-delivery-pg.XXXXXX")
# A private loopback port from 20000 up, so concurrent acceptance runs and any
# other local PostgreSQL never share a socket or a data directory.
port=$(python3 - <<'PY'
import random, socket
while True:
    port = random.randrange(20000, 60000)
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            continue
        print(port)
        break
PY
)
cleanup() { pg_ctl -D "$test_dir/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$test_dir"; }
trap cleanup EXIT
initdb -D "$test_dir/data" -A trust --no-locale >/dev/null
pg_ctl -D "$test_dir/data" -l "$test_dir/server.log" -o "-k $test_dir -h 127.0.0.1 -p $port" -w start >/dev/null
export PGHOST="$test_dir" PGPORT="$port" PGDATABASE=postgres PGUSER="$(id -un)"
# The API-role default grants are a hostile fixture: a migration that forgets to
# revoke them is refused by the sponsor acceptance rather than shipped.
psql -X -v ON_ERROR_STOP=1 -q -c 'create role service_role bypassrls; create role anon; create role authenticated; create role authenticator nologin noinherit; alter default privileges in schema public grant execute on functions to anon, authenticated; alter default privileges in schema public grant all on tables to anon, authenticated;'
migrations=("$repo"/db/services/migrations/*_relayer_delivery_*.sql)
if [ ! -f "${migrations[0]}" ]; then
  echo "no *_relayer_delivery_*.sql migrations under $repo/db/services/migrations" >&2
  exit 1
fi
for migration in "${migrations[@]}"; do
  echo "applying $(basename "$migration")"
  psql -X -v ON_ERROR_STOP=1 -q -f "$migration"
done
psql -X -v ON_ERROR_STOP=1 -q -f "$repo/tests/relayer-delivery-v2.sql"
psql -X -v ON_ERROR_STOP=1 -q -f "$repo/tests/relayer-delivery-evidence.sql"
psql -X -v ON_ERROR_STOP=1 -q -f "$repo/tests/relayer-delivery-sponsor.sql"
psql -X -v ON_ERROR_STOP=1 -q -f "$repo/tests/relayer-caller-scope.sql"
python3 "$repo/scripts/test-relayer-delivery-sponsor.py"
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
