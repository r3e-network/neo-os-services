# Morpheus Paymaster

## Purpose

Morpheus Paymaster is a policy-gated sponsorship service exposed by the Oracle runtime at:

- `POST /paymaster/authorize`

It is intended to sponsor pre-approved Neo N3 Abstract Account operations without exposing a global open faucet.

Current production architecture:

- ingress, auth, rate limit, and recovery stay outside the TEE
- the Oracle CVM executes the confidential authorization path
- mainnet and testnet may share Oracle CVM hardware, but the request hub uses
  separate network-scoped worker/relayer processes, policy variables, and
  request metadata for each network

Current runtime scope:

- active supported chain: `neo_n3`

## Security Model

The service does not blindly pay for arbitrary requests.

Current controls:

- network-scoped enable/disable flags
- policy ids
- per-network max gas limit
- per-network allowlisted target contracts
- per-network allowlisted inner user-operation target contracts
- per-network allowlisted method names
- optional per-network allowlisted account ids
- optional per-network blocklisted account ids
- optional per-network allowlisted dapp ids
- short-lived signed authorization result
- TEE attestation bound to the authorization payload

The returned payload includes:

- `approved`
- `network`
- `target_chain`
- `sponsorship_id`
- `expires_at`
- `output_hash`
- `signature`
- `public_key`
- `tee_attestation`

This makes the response portable across:

- AA relay backends
- first-party bundlers
- third-party sponsored execution gateways

## Environment Variables

### Testnet

- `MORPHEUS_PAYMASTER_TESTNET_ENABLED`
- `MORPHEUS_PAYMASTER_TESTNET_POLICY_ID`
- `MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS`
- `MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS`
- `MORPHEUS_PAYMASTER_TESTNET_ALLOW_USEROP_TARGETS`
- `MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS`
- `MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS`
- `MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS`
- `MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS`
- `MORPHEUS_PAYMASTER_TESTNET_TTL_MS`

### Mainnet

- `MORPHEUS_PAYMASTER_MAINNET_ENABLED`
- `MORPHEUS_PAYMASTER_MAINNET_POLICY_ID`
- `MORPHEUS_PAYMASTER_MAINNET_MAX_GAS_UNITS`
- `MORPHEUS_PAYMASTER_MAINNET_ALLOW_TARGETS`
- `MORPHEUS_PAYMASTER_MAINNET_ALLOW_USEROP_TARGETS`
- `MORPHEUS_PAYMASTER_MAINNET_ALLOW_METHODS`
- `MORPHEUS_PAYMASTER_MAINNET_ALLOW_ACCOUNTS`
- `MORPHEUS_PAYMASTER_MAINNET_BLOCK_ACCOUNTS`
- `MORPHEUS_PAYMASTER_MAINNET_ALLOW_DAPPS`
- `MORPHEUS_PAYMASTER_MAINNET_TTL_MS`

## Request Shape

```json
{
  "network": "testnet",
  "target_chain": "neo_n3",
  "account_id": "0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56",
  "dapp_id": "<allowlisted-production-dapp-id>",
  "target_contract": "0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2",
  "method": "executeUserOp",
  "userop_target_contract": "0xd2a4cff31913016155e38e474a2c06d08be276cf",
  "userop_method": "symbol",
  "estimated_gas_units": 120000,
  "operation_hash": "<32-byte-operation-hash>"
}
```

## zERC20 Builtins

Available builtins:

- `zkp.groth16.verify`
- `zkp.zerc20.single_withdraw.verify`

`zkp.zerc20.single_withdraw.verify` is a separate compute helper. It is not part of paymaster policy by default. Applications that need zERC20-specific sponsorship can build that rule on top of the generic paymaster flow.

## Integration Patterns

### 1. AA Relay / Bundler

Call `paymaster/authorize` just before relay submission.

Recommended order:

1. simulate the AA invocation
2. estimate gas units
3. call Morpheus Paymaster with normalized operation metadata
4. submit only if `approved === true`

### 2. Third-Party Bundler

The bundler can use the signed authorization as a sponsorship ticket and verify:

- signature
- `policy_id`
- `expires_at`
- `account_id`
- optional `dapp_id`
- `operation_hash`
- target contract
- method
- gas limit
- attestation metadata

### 3. Application Server

An app backend can pre-screen business policy, then delegate final sponsorship approval to Morpheus Paymaster so that:

- app policy remains app-specific
- TEE-signed sponsorship remains portable

## Current AA Integration

The AA frontend relay request builder now forwards optional `paymaster` metadata, and the AA relay API can request Morpheus paymaster authorization before broadcasting a relay-ready meta invocation.

This is currently a server-side integration path. It does not require changing the AA on-chain contract.

The latest integrated Oracle + NeoDID + AA verifier regression entrypoint is:

- `npm run examples:test:n3:attack-regression`
- reference docs: `docs/RELAYER.md`

## Validated Neo N3 Testnet Flow

The AA relay + Morpheus paymaster path has been validated live on Neo N3 testnet.

Validated service-side facts:

- network: `testnet`
- policy id: `testnet-aa`
- target chain: `neo_n3`
- allowed AA target contract: `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`
- allowed method: `executeUserOp`
- Oracle CVM app id: `ddff154546fe22d15b65667156dd4b7c611e6093`

Validated end-to-end flow:

1. register a V3 AA account
2. update the verifier key
3. update the paymaster allowlist on the CVM
4. simulate the AA invocation
5. request Morpheus paymaster authorization
6. relay the sponsored `executeUserOp`
7. confirm on-chain `HALT`

Successful live full-path validation example:

- account id: `0x531a5f4d3a916dffbba3ea372317623fdbbb853c`
- register txid: `0xf79d6a1d3012e9edc64c1a7e40abc932253c7f737873698055ad8f3df8a1869e`
- update verifier txid: `0xed9c97801a757fb0e3d72d641d75a6659c1242c084134234b5e7cd1a81e903d8`
- relay txid: `0x057d4a581efbe815fad0148a3766284da2a33335e72fb50e54d476078d8f40d4`
- paymaster approval digest: `04111a96d6356231c45fdb033ddc91818856c1dc0ac0ce09677ecdb033cae92f`
- paymaster attestation hash: `73849ae405db210d51c28ff63033bc4bb5f2f0886e1a7478c2557e1ac9c39886`

A successful replay path using an already allowlisted account was also validated:

- account id: `0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56`
- relay txid: `0x0481a3ca7b2af77f762ec50f19f0c81c973885d93d1d24b6f0fbb42cfe56cf04`

Operational note:

- The worker service itself remains protected and is not intended to be left as a public open endpoint.
- For the live validation harness, the most stable CVM access pattern was `phala cp` to upload a helper script, followed by `phala ssh` to execute it on the CVM.
- This replaced an earlier stdin-piped `phala ssh` bridge that was intermittently failing with transport error `255`.
