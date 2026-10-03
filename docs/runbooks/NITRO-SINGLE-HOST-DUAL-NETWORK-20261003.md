# Nitro single-host dual-network topology

Status: approved target topology; source and runbook policy only. No cloud
resource is created, restored, resized, or reconfigured by this document.

The deleted TestNet Nitro server is not required. NeoOS uses one approved
Nitro-capable host for the mainnet and TestNet workloads, with separate
network profiles and separately supervised processes or enclaves on that
host. A second TestNet host must not be introduced by deployment automation or
by a runbook copied from the historical dual-instance procedure.

## Isolation requirements

The cost-saving topology does not merge security domains:

- Mainnet and TestNet use different environment files, network identifiers,
  RPC origins, queues, metrics labels, and release manifests.
- Each network has its own signer/custody identity, KMS authorization scope,
  token namespace, and state directory. A TestNet credential must never be
  accepted by a mainnet process, and a mainnet credential must never be
  written to TestNet state.
- The host supervisor starts each profile with an explicit reviewed network
  value. An absent, unknown, or conflicting network value is a startup error;
  a URL path or request header cannot override the process profile.
- The profiles use distinct local listeners and resource limits. They may
  share the host kernel and Nitro allocator, but they do not share private
  keys, writable state, or unqualified IPC endpoints.
- Egress allow-lists, health checks, dashboards, alerts, and incident controls
  identify the network explicitly. A failed or ambiguous profile drains and
  stops its own new work; it must not fail open into the other network.
- The host must have enough enclave memory and CPU for both profiles under the
  documented load envelope. If that budget is not met, the safe action is to
  stop the affected profile, not to remove the network boundary.

## Deployment gate

Before an operator deploys or restarts either profile, the operator must
verify, without printing secret values:

1. The host is the single approved Nitro host and the old TestNet instance is
   absent from the active inventory.
2. The mainnet and TestNet environment files resolve to different reviewed
   network configurations, listeners, state directories, credentials, and
   release manifests.
3. The host has the required enclave capacity and the two profiles pass their
   network, KMS, attestation, and RPC preflight checks independently.
4. The measured image digest and PCR manifest match the approved release for
   each profile.
5. Metrics and alerts can distinguish the two profiles and the operator has a
   tested stop/drain procedure for one profile without stopping the other.

The source repository can validate configuration shape and separation. It
cannot prove host capacity, PCR state, KMS policy, or live service health.
Those are operator evidence requirements and remain outside this commit.

## Rollback and incident handling

If either profile fails preflight, has an ambiguous network identity, or
exceeds the shared host budget, do not start it. Drain and stop that profile,
preserve its evidence, and restore its last approved image/configuration. Do
not create a replacement TestNet host automatically and do not route TestNet
traffic to a mainnet profile.

The existing historical TestNet runbook contains a distinct-instance
procedure. It is retained as historical evidence only; this document is the
current single-host topology decision and must be consulted first.
