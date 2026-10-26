# Embedded relayer caller contract

The measured `MORPHEUS_EMBEDDED_RELAYER` gate defaults to `false`. Enabling it
selects one host process with independently configured Mainnet and Testnet
relayers. It does not authorize deployment, migration, issuance or provisioning.
The production delivery protocol remains v2. Existing single-context and
standalone maintenance interfaces retain their current defaults.

Public relayer profiles are checked by the build-only planner and, when the
measured gate is enabled, before runtime custody boot. The selected N3 endpoint
uses the existing network-scoped RPC configuration; registry fallbacks retain
their existing policy. Host health merges relayer readiness using the same
route classification as dispatch, including its accepted trailing slash.
An inner chain termination notifies the host before local shutdown awaits:
both networks stop accepting work and become draining while frontier/custody
dependencies remain owned until every strict drain completes.

## Durable authorization

The protected bearer is an issuer-signed JWT accepted and verified by the
existing PostgREST service. The caller role is `neoos_relayer_caller`, audience
is `authenticated`, scope is exactly `neoos/relayer-delivery/v2`, and
`neoos_network` is exactly `mainnet` or `testnet`. `iss` and `sub` identify the
approved issuer and stable caller; `neoos_epoch` must equal its enabled server
grant. `exp` and optional `nbf` have their normal numeric timestamp meaning.
Local claim parsing is only a consistency check and grants no authority.

The server must verify the signature, issuer, audience and validity before
selecting the SQL role and setting `request.jwt.claims`. SQL checks that actual
request role, the verified claims, the registered grant/epoch and migration
readiness. The grant table begins empty. Only the existing maintenance authority
may admit or revoke a caller after migration/cutover review; no loop enrolls
itself. No JWT is issued by these sources.

The scoped API profile is `neoos_relayer_v2`. It exposes exactly enqueue, claim,
transition, checkpoint, read-only feed-baseline and account-health RPCs. Each
request carries `p_network`. Transition checks the stored, locked job identity
before delegating to the existing state machine. Request/feed/XCM work for the
`oracle-updater` account is allowed; sponsor work, baseline seeding, legacy
imports, replay and operator reconciliation remain maintenance interfaces.
Existing signing bytes, completion identity, lease/generation fences and sponsor
trigger policies are retained.

The server pre-request guard restricts this role to those POST RPCs in this
profile. It is required in addition to minimal function grants, because SQL
roles also inherit PUBLIC privileges. An existing unrelated pre-request hook
must be composed and admitted explicitly; it must never be overwritten. The
role has no LOGIN, admin membership, BYPASSRLS, table or sequence grant. Granting
the role to the existing authenticated gateway is a separate admission action.

## Provision and rotation

The reviewed boot profile fixes the store HTTPS endpoint, public API key,
issuer, caller ID and per-network state path. Provisioning cannot alter them.
`MORPHEUS_RELAYER_AUTH_KMS_CIPHERTEXT_BASE64` contains a recipient-attested KMS
envelope with purpose `neoos/relayer-caller-auth/v1`, exact network, positive
version and `jwt`. Initial `/provision` may install it atomically with the
existing envelopes. After initial provisioning,
`/<network>/provision/relayer-auth` accepts only this encrypted credential field
and requires the current runtime authorization. Versions strictly increase
under the overlay write lock; rejected or stale material does not replace the
current credential. Temporary AWS credentials still refresh through the
existing credential-only route. No endpoint or policy is provisionable.

JWT refresh reads the current per-network overlay. Its local envelope version
is independent of the server grant epoch: normal refresh retains the grant
epoch, while revocation/re-admission changes the server epoch. Backoff is keyed
by store endpoint, network, issuer, subject and scope. JWT bytes, jti and envelope
version do not reset it. The public API key and bearer JWT are separate headers;
the embedded caller cannot fall back to a service-role key.

## Lifecycle and admission

The host waits for each network's actual protected provisioning. It presents
the existing runtime credential to the frontier and semantic Sign credential
to custody; no native Admin credential or generated credential is substituted.
Managed tasks retain their dependencies. Any lane termination or shutdown first
marks the process unhealthy, signals every relayer and joins/drains them before
closing frontier/custody. Strict embedded drain never abandons blocking work at
a timeout. Durable progress determines readiness; merely spawning a task does
not make the process healthy.

Before activation, independently qualify the actual JWT verifier and invalid
signature refusal, hook composition, role ACLs, caller grant/migration readiness,
protected envelopes, state lineage, measured image and current-host resources.
No production caller, profile, key or state is synthesized. D2 through D6 and
actual issuer grants, KMS operations and publication remain separate holds.
