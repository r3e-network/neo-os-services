# MorpheusDataFeed Upgrade

This runbook covers the `MorpheusDataFeed` contract update that introduces the
`morpheus-datafeed-v2` signed feed message. It is a coordinated contract/worker
change; the worker must not be switched to v2 signing against an old contract with
an enabled verification key.

## Prepare

1. Build and regenerate artifacts:

   ```bash
   bash contracts/build.sh
   ```

2. Run the contract and worker suites:

   ```bash
   dotnet test contracts/__tests__/NeoContracts.Tests.csproj -c Release --no-restore
   npm --prefix workers/nitro-worker test
   ```

3. Inspect the target and artifact without signing or broadcasting:

   ```bash
   node scripts/upgrade-morpheus-datafeed.mjs --network testnet
   ```

The script is read-only by default. Verify the network, target hash, NEF checksum,
and artifact digest in its JSON output.

## Apply

Only after the dry-run is reviewed, use an explicitly scoped network:

```bash
node scripts/upgrade-morpheus-datafeed.mjs --apply --network testnet
```

The script requires the pinned updater key from the network-scoped environment and
prints the target and artifact before invoking `update`. It refuses the legacy
`UPGRADE_APPLY=1` implicit mode and refuses `--apply` without `--network`.

Wait for the transaction application log and verify:

- `getcontractstate` reports the new NEF checksum and manifest;
- `oracleVerificationKey` is either unset or the expected key;
- a signed `UpdateFeedSigned` test invocation succeeds with the v2 worker vector;
- changing `attestationHash`, `sourceSetId`, network magic, or contract hash causes
  `invalid feed signature`.

## Enable signing

Deploy the worker code that builds the same v2 bytes, then register the matching
oracle verification key through the admin control path. Do not enable the key before
the contract update and worker rollout are both confirmed. Keep the unsigned path
disabled operationally once the key is registered; it is intentionally rejected by
the contract.

The immutable Neo X deployment is a separate concern and is not changed by this N3
upgrade.
