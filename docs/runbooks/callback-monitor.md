# Neo X Callback-Registration Monitor

Interim mitigation for **OR-D-03**: the deployed `MorpheusOracleEVM` kernel
(Neo X mainnet `0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2`, bytecode-frozen) has a
permissionless `registerMiniApp` whose callback reverse-mapping
(`_appByCallback[callbackContract]`) is **last-write-wins**. Anyone can register a fresh
appId over an existing app's callback contract; the kernel then resolves the attacker's
app for that contract's `requestFromCallback` calls, which revert `ModuleNotGranted` —
permanently bricking `MiniAppDiceGameEVM.placeBet` and `MiniAppMessageEVM.requestReveal`
until the owner counter-registers. The real fix (`require(_appByCallback[cb] == "")`)
ships with the next kernel deployment (see `contracts-evm/README.md`); until then this
monitor detects the attack within one timer cycle.

## What it does

`deploy/evm/callback-monitor.mjs` (oneshot, 15-min timer) scans the kernel's
`MiniAppRegistered(string,address,address)` logs
(topic0 `0x0a9520733397afef775ede12870471820a9f662c0425a29d47e21607f3f7fdb6`,
confirmed against the live kernel; deploy block 6733815) since the last scanned block
and alerts when:

1. **`CALLBACK HIJACK`** — a KNOWN callback contract is (re)registered under a foreign
   appId. Known callbacks are seeded from the repo build records:
   `dice` → `0xFA795F814d38F218153d21838360096f3F5cb774`,
   `message` → `0xd1906192c2308ae416aCDa96238cA846EBB83f15`
   (extend via `EXPECTED_CALLBACKS="0xaddr=appId,..."`).
2. **`CALLBACK REUSE`** — ANY new registration reuses an already-seen non-zero callback
   address (the second registration necessarily repoints the reverse mapping).

Violations are persisted in the state file, so the monitor stays red (exit 1) on every
subsequent run until acknowledged — a one-shot alert cannot be missed.

## Files / env

| What        | Default                                            | Env              |
| ----------- | -------------------------------------------------- | ---------------- |
| RPC         | `https://mainnet-1.rpc.banelabs.org`               | `NEOX_RPC`       |
| Kernel      | build record / `0xeCFC1C65…`                       | `KERNEL_ADDRESS` |
| State file  | `/opt/morpheus/nitro/callback-monitor-state.json`  | `STATE_FILE`     |
| Status file | `/opt/morpheus/nitro/callback-monitor-status.json` | `STATUS_FILE`    |
| Log         | `/opt/morpheus/nitro/callback-monitor.log`         | `MONITOR_LOG`    |

First run scans `latest - LOOKBACK_BLOCKS` (default 50000 ≈ 5 days) and pre-seeds the
seen-set with the expected owners, so a hijack older than the window still trips.
Exit codes: `0` ok, `1` violation (sticky), `2` RPC error (cursor not advanced).

## Install (box)

```bash
cp deploy/systemd/morpheus-callback-monitor.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now morpheus-callback-monitor.timer
systemctl start morpheus-callback-monitor.service   # first run now
cat /opt/morpheus/nitro/callback-monitor-status.json
```

## Responding to an alert

1. Read the violation in the status JSON (`problems` / `violations`: callback, foreign
   appId, admin, block, tx).
2. If it is a genuine hijack, the kernel owner **reclaims the mapping by re-registering a
   NEW appId over the same callback contract** (last-write-wins works for the defender
   too), then re-grants the modules to the new appId:
   ```bash
   NEOX_ADMIN_PK=0x.. node deploy/evm/oracle-admin.mjs register-app <new-appId> <admin> <callback>
   NEOX_ADMIN_PK=0x.. node deploy/evm/oracle-admin.mjs grant <new-appId> <moduleId>
   ```
   (`random.generate` for dice, `confidential.decrypt` lane via `decrypt` for message —
   check `deploy/evm/RUNBOOK.md`.) Old appIds cannot be re-registered (`AppExists`).
3. Update the expectation (`EXPECTED_CALLBACKS` in
   `/opt/morpheus/nitro/callback-monitor.env`) to the new appId.
4. Acknowledge: `node deploy/evm/callback-monitor.mjs ack` (clears stored violations,
   keeps the block cursor and seen-set).

## Validate locally

```bash
node --check deploy/evm/callback-monitor.mjs
node --test deploy/evm/callback-monitor.test.mjs
```
