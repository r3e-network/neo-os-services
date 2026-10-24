# AA Social Recovery / AA 社交恢复集成方案

This document defines the recommended integration between `neo-abstract-account` and Morpheus `NeoDID + MiniApp OS`.

本文定义 `neo-abstract-account` 与 Morpheus `NeoDID + MiniApp OS` 的标准集成方案。

## Goal / 目标

Recover control of an Abstract Account with privacy-preserving social factors such as Twitter, GitHub, Google, Email, Binance, or OKX, without exposing raw Web2 identity data on-chain.

在不把 Web2 明文身份暴露到链上的前提下，允许用户通过 Twitter、GitHub、Google、Email、Binance、OKX 等社交或平台身份恢复 Abstract Account 控制权。

## Recommended Model / 推荐模型

Use a dedicated AA custom verifier, for example `MorpheusSocialRecoveryVerifier`, instead of modifying the AA core contract.

推荐新增一个独立的 AA 自定义验证器，例如 `MorpheusSocialRecoveryVerifier`，而不是直接改 AA 核心合约。

Why:

- `neo-abstract-account` already supports per-account custom verifiers through `setVerifierContract`.
- Recovery logic remains isolated from the main wallet execution engine.
- NeoDID master nullifiers and action nullifiers map naturally to recovery factors and one-time recovery approvals.
- The shared MiniApp OS kernel can own IO, fee sponsorship, inbox delivery, and callback compatibility while NeoDID and AA keep their domain logic isolated.
- AA integrations may publicly namespace a recovery identity as `did:morpheus:neo_n3:aa:<account-id>` while still requiring a private NeoDID recovery ticket for actual authorization.

## Component Roles / 组件职责

### 1. Morpheus MiniApp OS Kernel

- Receives on-chain requests through the shared kernel contract
- Accepts both native kernel requests and legacy compatibility requests such as `MorpheusOracle.request(...)`
- Emits the kernel request event
- Relayer forwards the payload to the AWS Nitro worker
- Always fulfills the request into the system inbox, with optional external callback adapter delivery when configured

### 2. NeoDID Worker

- Verifies confidential provider data inside the TEE
- For `provider = "web3auth"`, verifies the JWT signature against Web3Auth JWKS inside the TEE and derives the stable DID root from token claims
- Derives:
  - `master_nullifier`
  - `action_nullifier`
- Signs a recovery ticket bound to a specific AA recovery round

### 3. MorpheusSocialRecoveryVerifier

- Stores allowed recovery factors as `master_nullifier`
- Stores used approvals as `action_nullifier`
- Verifies the Morpheus / NeoDID signature
- Applies threshold and timelock
- Switches recovery ownership to `newOwner`

### 4. Abstract Account

- Keeps using its existing `custom verifier` interface:
  - `verifyExecution(accountId)`
  - `verifyExecutionMetaTx(accountId, signerHashes)`
  - `verifyAdmin(accountId)`
  - `verifyAdminMetaTx(accountId, signerHashes)`
- Delegates recovery authorization to the recovery verifier

## Canonical Request Types / 标准请求类型

These request types can now be routed through the Morpheus kernel request pipeline:

- `neodid_bind`
- `neodid_action_ticket`
- `neodid_recovery_ticket`

This means AA recovery no longer needs a side-channel worker call. The preferred production path is:

这意味着 AA 恢复不需要旁路调用 worker。生产环境推荐路径是：

1. User contract or recovery coordinator submits a kernel request for `neodid_recovery_ticket`.
2. The legacy-compatible path may still call `MorpheusOracle.request("neodid_recovery_ticket", payload, callbackContract, callbackMethod)` during migration.
3. Morpheus relayer routes the request to `/neodid/recovery-ticket`.
4. TEE signs the recovery ticket.
5. The kernel inbox stores the result, and optional callback adapters may store or forward the ticket to the AA recovery verifier flow.

## Recovery Ticket Schema / 恢复票据结构

`neodid_recovery_ticket` returns a signed result shaped like:

```json
{
  "mode": "neodid_recovery_ticket",
  "network": "neo_n3",
  "aa_contract": "0x711c1899a3b7fa0e055ae0d17c9acfcd1bef6423",
  "account_id_raw": "<raw-20-byte-account-id>",
  "verifier_contract": "<aa-recovery-verifier-contract-hash>",
  "account_address": "0x6d0656f6dd91469db1c90cc1e574380613f43738",
  "account_id": "<aa-account-id>",
  "new_owner": "0x89b05cac00804648c666b47ecb1c57bc185821b7",
  "recovery_nonce": "7",
  "expires_at": "1735689600",
  "provider": "github",
  "action_id": "aa_recovery:<network>:<aa-contract>:<aa-account-id>:<new-owner>:<nonce>",
  "master_nullifier": "0x...",
  "action_nullifier": "0x...",
  "digest": "0x...",
  "signature": "...",
  "public_key": "...",
  "signer_address": "...",
  "signer_script_hash": "...",
  "output_hash": "...",
  "attestation_hash": "...",
  "verification": {
    "output_hash": "...",
    "attestation_hash": "...",
    "signature": "...",
    "public_key": "...",
    "tee_attestation": {
      "app_id": "...",
      "compose_hash": "...",
      "report_data": "0x..."
    }
  }
}
```

The signing domain is `neodid-recovery-v2`: the digest includes `account_id_raw`
and the AA core, so identical textual identities, addresses, factors, and action
IDs cannot make one ticket valid for a different raw account. Direct submission
also re-derives the recovery action ID from the raw account, new owner, and
current recovery nonce. Compact result encoding remains v3, while tickets issued
before raw-account binding are rejected by the upgraded verifier. A coordinated
upgrade must drain or migrate in-flight requests rather than accept old signatures.

## What The Verifier Must Check / 验证器必须检查的内容

The AA recovery verifier should verify:

- `signature` is valid for `digest`
- signer public key matches the configured NeoDID/Morpheus verifier key
- `expires_at` has not passed
- `aa_contract` matches the configured AA master contract
- `account_id_raw` matches the raw 20-byte account ID, not merely a proxy address or shared textual identity
- `account_id` matches the account being recovered
- `new_owner` matches the pending recovery target
- `recovery_nonce` matches the current recovery round
- `master_nullifier` belongs to an allowed recovery factor
- `action_nullifier` has not already been used

AA 恢复验证器应验证：

- `signature` 对 `digest` 有效
- 签名公钥等于预配置的 NeoDID/Morpheus verifier key
- `expires_at` 未过期
- `aa_contract` 与当前 AA 主合约一致
- `account_id_raw` 与原始 20 字节账户 ID 一致，而不是仅凭 proxy 地址或共享文本身份
- `account_id` 与被恢复账户一致
- `new_owner` 与本次待恢复的新地址一致
- `recovery_nonce` 与当前恢复轮次一致
- `master_nullifier` 属于允许的恢复因子集合
- `action_nullifier` 未被使用

## Confidential Input Model / 隐私输入模型

Sensitive fields should be encrypted with the NeoOS Oracle public key and passed as `encrypted_params`.
If the ciphertext is too large for the chain request payload, store it first and pass `encrypted_params_ref` instead.

敏感字段应使用 NeoOS Oracle 公钥加密，并通过 `encrypted_params` 传入。

Example confidential patch:

```json
{
  "id_token": "<web3auth jwt>",
  "verified_email": "alice@example.com",
  "linked_accounts": ["google", "email", "sms"]
}
```

Example on-chain request payload:

```json
{
  "provider": "web3auth",
  "network": "neo_n3",
  "aa_contract": "0x711c1899a3b7fa0e055ae0d17c9acfcd1bef6423",
  "account_id_raw": "<raw-20-byte-account-id>",
  "verifier_contract": "<aa-recovery-verifier-contract-hash>",
  "account_id": "<aa-account-id>",
  "new_owner": "0x89b05cac00804648c666b47ecb1c57bc185821b7",
  "recovery_nonce": "7",
  "expires_at": "1735689600",
  "encrypted_params": "<base64 ciphertext>"
}
```

Large-JWT alternative:

```json
{
  "provider": "web3auth",
  "network": "neo_n3",
  "aa_contract": "0x711c1899a3b7fa0e055ae0d17c9acfcd1bef6423",
  "account_id_raw": "<raw-20-byte-account-id>",
  "verifier_contract": "<aa-recovery-verifier-contract-hash>",
  "account_id": "<aa-account-id>",
  "new_owner": "0x89b05cac00804648c666b47ecb1c57bc185821b7",
  "recovery_nonce": "7",
  "expires_at": "1735689600",
  "encrypted_params_ref": "<secret_ref>"
}
```

The worker looks the ref up under its own `MORPHEUS_NETWORK`: in a recovery
ticket `network` names the chain family (`neo_n3`), not a Morpheus network. The
Rust enclave host serves only a direct `encrypted_params` today and answers a
ref with 503.

worker 在自己的 `MORPHEUS_NETWORK` 下查找该 ref：恢复票据中的 `network`
表示链族（`neo_n3`），不是 Morpheus 网络。Rust enclave host 目前只接受直接传入的
`encrypted_params`，对 ref 返回 503。

### Web3Auth As The DID Root / 用 Web3Auth 作为 DID 根身份

Recommended production model:

- users authenticate with Web3Auth
- multiple linked social providers still map to one stable Web3Auth user id
- NeoDID uses:
  - `provider = "web3auth"`
  - `id_token = <Web3Auth JWT>`
- the TEE verifies the JWT and derives the stable provider root internally
- `provider_uid`, if sent at all, is only treated as an optional consistency check
- AA recovery verifiers only care about NeoDID tickets derived from that stable identifier

推荐生产模式：

- 用户先通过 Web3Auth 登录
- 多个社交账号在 Web3Auth 内部聚合成同一个稳定用户 id
- NeoDID 统一使用：
  - `provider = "web3auth"`
  - `id_token = <Web3Auth JWT>`
- TEE 在内部验证 JWT，并派生稳定的 provider 根标识
- 如果额外传入 `provider_uid`，它只作为可选一致性检查使用
- AA 恢复验证器只消费由这个稳定标识导出的 NeoDID 票据，不关心底层具体用了 Google、Email 还是 SMS

## Recommended Recovery Lifecycle / 推荐恢复流程

### Setup Phase / 初始化阶段

1. User binds Web2 / exchange identities into NeoDID.
2. User registers selected `master_nullifier` values into `MorpheusSocialRecoveryVerifier`.
3. User sets:
   - threshold, for example `2-of-3`
   - timelock, for example `3 days`
   - recovery nonce start value

### Recovery Phase / 恢复阶段

1. User loses access to the original owner wallet.
2. User chooses a new owner address `newOwner`.
3. User requests one or more `neodid_recovery_ticket` approvals through the Morpheus MiniApp OS kernel.
4. Each successful factor submits one ticket to the verifier.
5. The verifier marks each `action_nullifier` as used and counts unique approved `master_nullifier` factors.
6. Once threshold is reached, the verifier opens a pending recovery timelock.
7. When timelock expires, the verifier finalizes the recovery and switches the verifier-side owner to `newOwner`.
8. The recovered owner rotates AA admins/managers immediately.

## Why This Is Better Than Dome-Only Recovery / 为什么优于仅 Dome 恢复

AA already has a dome + oracle inactivity path, but that path is best for inactivity unlocking, not for multi-factor identity recovery.

AA 现在已有 dome + oracle 的不活跃恢复通道，但那条路径更适合“不活跃后解锁”，不适合表达多因子身份恢复。

This NeoDID-based model adds:

- privacy-preserving factor commitments
- one-time recovery approvals via `action_nullifier`
- factor reuse prevention
- multi-provider thresholds
- recovery-round binding through `recovery_nonce`
- portable TEE attestation and signature evidence

## Security Rules / 安全规则

Do not ship this flow without:

- at least `2-of-N` threshold for valuable accounts
- `expires_at`
- `recovery_nonce`
- timelock
- `cancelRecovery`
- `usedActionNullifier`
- post-recovery admin rotation

高价值账户不应使用单因子恢复。至少要有：

- `2-of-N` 阈值
- `expires_at`
- `recovery_nonce`
- timelock
- `cancelRecovery`
- `usedActionNullifier`
- 恢复完成后的管理员轮换

## Recommended AA-Side Contract Interface / 推荐的 AA 侧接口

Suggested verifier-side interface:

```csharp
public static void SetupRecovery(
    ByteString accountId,
    UInt160 aaContract,
    ByteString[] allowedMasterNullifiers,
    BigInteger threshold,
    BigInteger timelockSeconds);

public static void SubmitRecoveryTicket(
    ByteString accountId,
    UInt160 newOwner,
    BigInteger recoveryNonce,
    ByteString masterNullifier,
    ByteString actionNullifier,
    string expiresAt,
    ByteString verificationSignature);

public static void FinalizeRecovery(ByteString accountId);
public static void CancelRecovery(ByteString accountId);
```

## Integration Status In This Repo / 当前仓库里的实现状态

Implemented here:

- worker route: `/neodid/recovery-ticket`
- web proxy route: `/api/neodid/recovery-ticket`
- relayer routing support for `neodid_recovery_ticket`
- on-chain callback envelope preservation for recovery ticket fields

Still belongs to the AA repository:

- concrete `MorpheusSocialRecoveryVerifier` contract
- verifier deployment and live AA integration tests
- frontend recovery wizard inside `neo-abstract-account`
