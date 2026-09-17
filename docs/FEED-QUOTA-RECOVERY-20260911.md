# Feed Quota Recovery Audit

Date: 2026-09-11.
Status: daily quota exhaustion confirmed; live quote recovery incomplete.

## September 12 Current-State Revalidation

Read-only SSM command 7c4fb963-7ddb-44d7-b98c-0bc1a148699e succeeded on
i-0c52851f134db20ee (morpheus profile, us-east-1). Reused the reviewed transient
provider probe with a distinct unit name. Current provider response remains
HTTP 429 / code 429, daily=true, credits=true, minute=false, month=false,
subscriptionExpired=false, usablePrice=false, Retry-After absent. This is a
current probe, not a conclusion inferred solely from the older report. No
provider credential, raw provider message, signature, or transaction was output.

Topology commands a2c3c716-847b-4764-b10e-b31ebdfe8307 and
850d5213-12b6-474b-be5c-25fd83042d88 both succeeded:

- morpheus-relayer.service has no installed fragment and is inactive.
- morpheus-relayer-nitro.service is active/running, started June 15; its running
  executable is /usr/bin/node, NOT evidence of deployed Rust relayer authority.
- morpheus-nitro-signer.service is active/running, started June 15.
- N3 and Neo X feed timers are active at five/two minute intervals respectively.
- Both feed units are oneshot, currently inactive after finishing with
  ExecMainStatus=0 / Result=success. No SuccessExitStatus override is configured.
- N3 has OnFailure=morpheus-alert@morpheus-feed-pusher.service.service;
  Neo X has no OnFailure handler. These do not establish functioning alert delivery.
- ENABLE_NODE_FEED_PUSHER_COMPAT is absent. Nevertheless the deployed feed units
  pass their conditions. The current repository compatibility-only unit gates
  therefore do not describe deployed topology.
- Deployed feed-pusher.mjs SHA256:
  8fdfb84959ee59bf6dc137d5e5e8d720c6df89c0a3450d68ea9f90e3f1eaf312.

This establishes deployment drift and a health-observability gap: successful
process completion is not successful feed advancement. It does not prove the
exact code path of each completed cycle; no raw journal was exported. Do not
stop Node services on the assumption that the Rust replacement is running.

No persistent host configuration, scheduler, signer, quota plan, or chain state
was changed. Provider recovery needs usable authorized quota; purchasing a plan
or substituting a provider is not authorized by these diagnostic actions.
Required next evidence: approved provider capacity, measured production writer
migration/rollback plan, confirmed on-chain source/publication advancement,
and successful actual-runtime quote acceptance. Other NeoOS work remains open.

## Current Evidence

SSM command 5458e4b1-9810-4f71-8243-c626d1323d2e succeeded against documented
writer i-0c52851f134db20ee using profile morpheus, region us-east-1.
It read timer properties and ran a transient read-only provider probe using
the existing server-side TD_KEY. Only whitelisted diagnostic fields were
returned; the key and raw provider message were not exported.

- N3 pusher timer: active, OnUnitActiveUSec=5min.
- Neo X pusher timer: active, OnUnitActiveUSec=2min.
- Provider HTTP status/code: 429.
- Provider message classification: daily=true, credits=true, minute=false,
  month=false, subscriptionExpired=false.
- No usable price, no numeric Retry-After supplied.

This is daily credit exhaustion, not evidence that restarting a timer or
retrying immediately can fix it. It does not establish the plan's numeric
quota, reset time, other consumers' usage, or every cause of the historical
stall. Existing documentation about expired subscriptions is historical.

Prior current-state evidence is in Explorer's
INTENT-LIVE-FEED-AUDIT-20260911.md: 32/32 active mainnet feed pairs stale,
funded updater, last source records on August 29, running Nitro/relayer,
monitor/alert failures, and stale data rejected by the actual Swap runtime.

## Implemented Locally

The compatibility Node pusher now classifies daily quota, minute throttling,
unclassified throttling, expired subscriptions and authorization failures.
The cycle status retains a bounded provider_category while keeping the existing
twelvedata_fetch_failed error code and nonzero exit.

Batch parsing validates individual provider errors even when the HTTP status
and outer body appear successful. A batch with zero usable positive finite
prices fails immediately. Missing entries in a partially valid batch remain
subject to the existing missing-symbol policy.

Price parsing now rejects booleans, arrays, objects, hexadecimal/binary strings,
whitespace-padded strings, non-finite values, and values that underflow to zero.
Only positive finite numeric primitives or decimal strings (including exponent
notation) are accepted. Invalid entries remain missing in a partially valid
batch; an entirely invalid batch fails. This closes implicit Number coercion,
not floating-point precision or source-authenticity proof obligations.

These changes are not deployed. Current repository Node writer units are
compatibility-only; they must not be enabled alongside the production writer.
No signer/EIF, scheduler, persistent production configuration, or chain state
was changed by this turn.

## Validation And Remaining Gates

Targeted feed-pusher and network-policy tests: 79 passed, 0 failed.
Prior full feed-pusher directory regression: 152 passed, 0 failed.
After numeric-input hardening: full directory regression 154 passed, 0 failed,
using `node --test 'deploy/feed-pusher/*.test.mjs'`.
Scoped git diff whitespace validation passed.

Read-only mainnet recheck completed at 2026-09-11T13:41:18.685Z with
`node scripts/audit-feed-health.mjs --network mainnet --stale-hours 0.1666666667 --skip-aws --json`.
Exit 1: 32/32 active pairs stale against the 600-second SLO, plus 4 retired
pairs excluded from failure counts. Latest NEO record remains
2026-08-29T09:39:01.000Z; updater GAS remains 40.89213258 and ABI probes pass.
A request returned HTTP 502 during execution, but the audit ultimately obtained
readable chain records. AWS/provider quota was not re-probed in this recheck.
No production deployment or chain write was performed.

Recovery requires adequate authorized provider capacity and a verified writer
deployment/scheduling plan. Do not reduce required pair coverage, relax Swap's
freshness threshold, or substitute an unaudited provider to get a green result.
After recovery, require confirmed on-chain timestamp advancement and rerun the
actual-runtime successful-quote browser test. Negative stale-rejection checks
are not successful-quote acceptance.
