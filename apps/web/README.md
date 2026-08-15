# Morpheus Web

`apps/web` is the public dashboard, docs site, explorer, and backend route layer for Morpheus.

It serves four roles:

1. public documentation and explorer UI
2. developer launchpad for Oracle, compute, feeds, and verifier flows
3. backend routes used directly by operators and by the control plane
4. attestation verification and network-registry presentation

## Public API surface

- `/api/oracle/public-key`
- `/api/oracle/query`
- `/api/oracle/smart-fetch`
- `/api/compute/functions`
- `/api/compute/execute`
- `/api/feeds/[symbol]`
- `/api/feeds/catalog`
- `/api/feeds/status`
- `/api/runtime/catalog`
- `/api/runtime/status`
- `/api/runtime/info`
- `/api/runtime/health`
- `/api/workflows`
- `/api/policies`
- `/api/attestation/verify`

## Operator / internal routes

- `/api/internal/control-plane/feed-tick`
- `/api/internal/control-plane/callback-broadcast`
- `/api/internal/control-plane/automation-execute`
- `/api/provider-configs`
- `/api/sign/payload`
- `/api/relay/transaction`

## Validation

```bash
npm --prefix apps/web test
npm --prefix apps/web run build
```
