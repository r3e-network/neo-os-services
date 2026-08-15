# Attestation Payload Spec

This document explains what Morpheus currently stores in `attestation_hash`, what users should verify, and how the built-in verifier works.

## 1. Current Hash Model

Today, Morpheus uses the following rule across Oracle, Compute, Feed, and VRF flows:

- `attestation_hash == output_hash`
- `output_hash = sha256(stableStringify(canonical_result_payload))`
- `tee_attestation.report_data[0:32] == output_hash`

Important:

- TDX `report_data` is 64 bytes.
- Morpheus uses the first 32 bytes as the application binding.
- The remaining 32 bytes are usually zero padding and must be ignored for app-level verification.

## 2. What Is The Canonical Payload?

The hash is not computed over the entire HTTP response body. It is computed over the canonical business payload for that execution path.

- Oracle fetch / smart-fetch:
  - `{ target_chain, target_chain_id, request_source, result, extracted_value, upstream_status }`
- Compute builtin / script:
  - the compute result object returned by the worker, for example `{ runtime, function, result }` or `{ runtime, entry_point, result }`
- Pricefeed sync:
  - the canonical quote object, including `feed_id`, `pair`, `display_symbol`, `unit_label`, `provider`, `raw_price`, `price_transform`, `price_multiplier`, `price`, `decimals`, `timestamp`, `sources`
- VRF:
  - `{ randomness }`

## 3. How Users Verify `attestation_hash`

### A. Oracle / Compute callback verification

If your contract receives a callback result envelope like:

```json
{
  "version": "morpheus-result/v1",
  "request_type": "oracle",
  "success": true,
  "result": { "...": "..." },
  "verification": {
    "output_hash": "0x...",
    "attestation_hash": "0x...",
    "tee_attestation": {
      "app_id": "...",
      "compose_hash": "...",
      "report_data": "0x..."
    }
  }
}
```

verify it in this order:

1. Read `verification.output_hash`.
2. Read `verification.attestation_hash`.
3. Confirm they are equal.
4. Read `verification.tee_attestation.report_data`.
5. Take the first 32 bytes of `report_data`.
6. Confirm that first 32-byte prefix equals `attestation_hash`.
7. If you know the canonical result payload, compute `sha256(stableStringify(payload))` and confirm it also equals `output_hash`.
8. Optionally confirm `app_id`, `compose_hash`, and `instance_id` against the published Morpheus deployment metadata.

### B. Pricefeed on-chain verification

If you read a feed record from the on-chain datafeed contract:

```json
{
  "pair": "TWELVEDATA:NEO-USD",
  "roundId": 123,
  "price": 1234,
  "timestamp": 1710000000,
  "attestationHash": "0x..."
}
```

the chain only stores the compact `attestation_hash`, not the full quote.

To verify that hash:

1. Fetch the matching feed publication record from Morpheus operational logs / audit logs.
2. Rebuild the canonical quote payload for that exact publication.
3. Compute `sha256(stableStringify(quote_payload))`.
4. Confirm the computed hash equals the on-chain `attestationHash`.
5. If the publication log includes `tee_attestation`, confirm the first 32 bytes of `report_data` equal the same hash.

Without the off-chain publication record, you can verify chain consistency of the stored hash, but you cannot fully reconstruct the original TEE quote from the chain record alone.

## 4. Built-In Verifier

The web verifier is available at:

- `/verifier`
- `/api/attestation/lookup`
- `/api/attestation/verify`

It accepts:

- full worker responses
- compact callback envelopes
- raw `tee_attestation` objects
- stored attestation lookups by `attestation_hash`
- optional expected payload JSON
- optional expected `output_hash`
- optional expected or on-chain `attestation_hash`
- optional `app_id`, `compose_hash`, and `instance_id`

The verifier returns:

- `binding_ok`
  - `output_hash`, `attestation_hash`, and `report_data` prefix are consistent
- `full_attestation_ok`
  - same as above, plus a full quote and event log were attached

## 5. Scope

The built-in verifier is an application-level verifier.

It does:

- verify `output_hash`
- verify `attestation_hash`
- verify `report_data` first-32-byte binding
- verify `app_id` / `compose_hash` / `instance_id` when supplied

It does not:

- fully validate Intel / TDX certificate chains
- independently validate platform trust roots

## 6. Published Morpheus CVM Explorers

The current production topology is role-split, not network-split:

- Oracle request/response CVM:
  - `oracle-morpheus-neo-r3e`
  - app id `ddff154546fe22d15b65667156dd4b7c611e6093`
  - attestation verified in-app via `POST /api/attestation/verify` (or the `/verifier` page)
- DataFeed CVM:
  - `datafeed-morpheus-neo-r3e`
  - app id `ac5b6886a2832df36e479294206611652400178f`
  - attestation verified in-app via `POST /api/attestation/verify` (or the `/verifier` page)

Both mainnet and testnet Oracle traffic now terminate at the Oracle CVM and differ only by the
network selected in the request path or payload. Feed synchronization runs on the dedicated
DataFeed CVM.

## 中文说明

### 1. 当前 `attestation_hash` 的含义

目前系统里：

- `attestation_hash == output_hash`
- `output_hash = sha256(stableStringify(规范结果载荷))`
- `tee_attestation.report_data` 的前 32 字节等于这个 hash

注意：

- `report_data` 总长度通常是 64 字节
- 真正要比对的是前 32 字节
- 后 32 字节一般是补零，不能拿整段直接和 32 字节 hash 比

### 2. 用户应该怎么验

#### Oracle / Compute 回调

拿到链上 callback 的 `result` JSON 后：

1. 读取 `verification.output_hash`
2. 读取 `verification.attestation_hash`
3. 确认两者相等
4. 读取 `verification.tee_attestation.report_data`
5. 截取前 32 字节
6. 确认这个前缀等于 `attestation_hash`
7. 如果你能拿到规范结果载荷，就自己重新做 `sha256(stableStringify(payload))`
8. 确认算出来的值也等于 `output_hash`

#### Pricefeed 链上记录

链上的 datafeed record 只保存了 `attestation_hash`，没有保存完整 quote。

因此要验证它：

1. 从 Morpheus 的操作日志 / 审计日志里拿到对应那次发布的完整 quote 记录
2. 用同样的规范序列化方式重建 quote payload
3. 计算 `sha256(stableStringify(payload))`
4. 和链上的 `attestation_hash` 比较
5. 如果日志里有 `tee_attestation`，再确认 `report_data` 前 32 字节也等于这个 hash

只看链上 record 本身，只能验证“链上存了什么 hash”，不能单独还原完整 TEE quote。

### 3. 前端 verifier 能做什么

`/verifier` 现在支持直接粘贴：

- 完整 worker 响应
- 链上 callback 的紧凑 envelope
- 原始 `tee_attestation` JSON

并且支持额外输入：

- 期望的 `output_hash`
- 期望的 / 链上的 `attestation_hash`
- `app_id`
- `compose_hash`
- `instance_id`

### 4. 当前 verifier 的边界

当前 verifier 是“应用层验证”，不是完整的 TDX 证书链验证。

### 5. 当前的 attestation 验证

当前生产拓扑是按角色拆分，不是按网络拆分：

- Oracle 请求/响应 CVM
  - 名称：`oracle-morpheus-neo-r3e`
  - app id：`ddff154546fe22d15b65667156dd4b7c611e6093`
  - attestation 通过应用内 `POST /api/attestation/verify`（或 `/verifier` 页面）验证
- DataFeed CVM
  - 名称：`datafeed-morpheus-neo-r3e`
  - app id：`ac5b6886a2832df36e479294206611652400178f`
  - attestation 通过应用内 `POST /api/attestation/verify`（或 `/verifier` 页面）验证
