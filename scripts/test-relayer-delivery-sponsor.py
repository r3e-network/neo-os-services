#!/usr/bin/env python3
"""Independent-session sponsor reservation acceptance on real PostgreSQL.

Called from scripts/test-relayer-delivery-v2.sh inside its disposable cluster.
Every identity and transaction byte is synthetic: this proves the storage
contract (journal committed before any other session can read the bytes,
budget reservation under concurrency, idempotent replay). It performs no
signing and no network broadcast, and it never opens a remote database.
"""
import concurrent.futures
import json
import os
import selectors
import subprocess
import uuid

PSQL = ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]
os.environ["PGOPTIONS"] = "-c statement_timeout=15000 -c lock_timeout=10000"
CONTRACT = "0x" + "1" * 40


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def run(sql, expected_error=None):
    result = subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True, timeout=30)
    if result.returncode:
        if expected_error and expected_error in result.stderr:
            return None
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def reserve(principal, key, fee, intent=None):
    return ("public.morpheus_delivery_sponsor_reserve('testnet',"
            f"{literal(principal)},{literal(key)},'{CONTRACT}','sponsor-account',"
            f"{literal(json.dumps(intent or {}))},{fee})")


def reset():
    run("truncate public.morpheus_sponsor_intents, public.morpheus_delivery_jobs, "
        "public.morpheus_sponsor_lifetime_budgets, public.morpheus_sponsor_daily_budgets, "
        "public.morpheus_sponsor_global_budgets cascade")


def totals():
    return json.loads(run("select json_build_array("
        "(select count(*) from public.morpheus_sponsor_intents),"
        "(select coalesce(sum(reserved_fee_units),0) from public.morpheus_sponsor_lifetime_budgets),"
        "(select coalesce(sum(reserved_actions),0) from public.morpheus_sponsor_daily_budgets),"
        "(select coalesce(sum(reserved_fee_units),0) from public.morpheus_sponsor_global_budgets))"))


def race(name, calls, expected_successes, expected_totals, error=None):
    reset()

    def request(call):
        return run(f"begin; set local role service_role; select {call}; "
                   "select pg_sleep(0.02); commit", error)

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(request, calls))
    assert sum(result is not None for result in results) == expected_successes, name
    assert totals() == expected_totals, (name, totals())
    print(f"PASS: {name}: {expected_successes}/{len(calls)} accepted, budgets {expected_totals}")


principal = str(uuid.uuid4())
race("concurrent lifetime ceiling", [reserve(principal, str(i), 2000000) for i in range(12)],
     10, [10, 20000000, 10, 20000000], "sponsor lifetime budget exceeded")
race("concurrent daily action ceiling", [reserve(principal, str(i), 1) for i in range(12)],
     10, [10, 10, 10, 10], "sponsor daily action budget exceeded")
race("concurrent global ceiling", [reserve(uuid.uuid4(), str(i), 20000000) for i in range(28)],
     25, [25, 500000000, 25, 500000000], "sponsor global budget exceeded")
race("concurrent identical replay", [reserve(principal, "identical", 1000000)] * 12,
     12, [1, 1000000, 1, 1000000])
race("concurrent conflicting replay", [reserve(principal, "conflict", 1, {"n": i}) for i in range(12)],
     1, [1, 1, 1, 1], "sponsor idempotency conflict")

reset()
run(f"begin; set local role service_role; select {reserve(principal, 'rolled-back', 1000000)}; rollback")
assert totals() == [0, 0, 0, 0], "rollback leaked a reservation"
print("PASS: rollback removes both the intent and every budget debit")

session = subprocess.Popen(PSQL, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, bufsize=1)


def command(sql):
    session.stdin.write(sql + ";\n")
    session.stdin.flush()
    with selectors.DefaultSelector() as selector:
        selector.register(session.stdout, selectors.EVENT_READ)
        assert selector.select(20), "database session timed out"
    line = session.stdout.readline().strip()
    if not line:
        raise AssertionError("database session stopped: " + session.stderr.read())
    return json.loads(line)


try:
    job = command(f"begin; set local role service_role; select {reserve(principal, 'commit', 1000000)}")
    assert totals() == [0, 0, 0, 0], "uncommitted intent visible to another session"
    job = command("select public.morpheus_delivery_claim('testnet','neo_n3','sponsor-account',"
                  "'worker',60000,array['sponsor'])")
    key = literal(job["job_key"])
    command(f"select public.morpheus_delivery_transition({key},'worker',1,'prepared',"
            "'{\"fee_ceiling_units\":1000000}',60000)")
    signed = json.dumps({"tx_hash": "0x" + "a" * 64, "raw": "00ab"})
    command(f"select public.morpheus_delivery_transition({key},'worker',1,'signed',{literal(signed)},60000)")
    # Simulated broadcaster reads only committed jobs bound to durable intents.
    read_bytes = ("select j.journal->'signed'->>'raw' from public.morpheus_delivery_jobs j "
                  "join public.morpheus_sponsor_intents i using(job_key) where j.job_key=" + key)
    assert run(read_bytes) == "", "broadcast bytes escaped before journal commit"
    command("commit; select to_jsonb(true)")
    assert run(read_bytes) == "00ab", "committed signed journal not available"
    assert totals() == [1, 1000000, 1, 1000000], "commit lost reservation"
    # Crash/unknown outcome and a retry never refund or debit a second time.
    run(f"set role service_role; select public.morpheus_delivery_transition({key},'worker',1,"
        "'retry','{\"error\":\"submission unknown\"}',60000)")
    replay = json.loads(run(f"set role service_role; select {reserve(principal, 'commit', 1000000)}"))
    assert replay["status"] == "broadcast_unknown"
    assert replay["journal"]["signed"]["raw"] == "00ab"
    assert totals() == [1, 1000000, 1, 1000000], "unknown outcome changed charged budgets"
    print("PASS: independent-session journal-before-broadcast visibility and unknown-outcome replay")
    # Age the fixture as the database owner; the application has no clock override
    # or mutation privilege. A retry from yesterday still uses its original charge.
    for table in ["intents", "daily_budgets", "global_budgets"]:
        run(f"update public.morpheus_sponsor_{table} set budget_day=budget_day-1")
    run(f"set role service_role; select {reserve(principal, 'commit', 1000000)}")
    assert totals() == [1, 1000000, 1, 1000000], "next-day replay charged again"
    run(f"set role service_role; select {reserve(principal, 'next-day', 1)}")
    assert totals() == [2, 1000001, 2, 1000001], "next-day reservation lost lifetime usage"
    assert run("select count(*) from public.morpheus_sponsor_daily_budgets") == "2"
    print("PASS: next-day replay retains original charge; new admission keeps lifetime usage")
finally:
    if session.poll() is None:
        session.stdin.close()
        try:
            session.wait(timeout=5)
        except subprocess.TimeoutExpired:
            session.kill()
            session.wait()
reset()
