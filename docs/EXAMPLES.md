# Examples / 示例大全

This guide gives concrete examples for the most common Morpheus combinations:

- user contracts calling the Oracle
- passing encrypted parameters
- calling built-in compute functions
- calling built-in functions with encrypted payloads
- calling Oracle with custom functions
- calling Oracle with custom functions plus encrypted params
- reading on-chain pricefeed data
- browser and Node encryption helpers

本指南给出 Morpheus 常见组合的可直接参考示例：

- 用户合约如何调用预言机
- 如何传递加密参数
- 如何调用内置计算函数
- 如何调用“内置函数 + 加密参数”
- 如何调用“预言机 + 自定义函数”
- 如何调用“预言机 + 自定义函数 + 加密参数”
- 如何读取链上 pricefeed
- 浏览器端和 Node 端加密示例

Concrete files also live under:

对应的可复制文件也已经放在：

- `examples/README.md`
- `examples/payloads/`
- `examples/contracts/n3/`
- `examples/contracts/n3/`
- `examples/browser-encryption/`
- `examples/node-encryption/`
- `examples/wasm/`

Current support note:

- Neo N3 is the only actively supported public integration path right now.
- Any legacy EVM examples that still appear below are archived reference material and should not be used as the default starting point for new integrations.

## Who Should Read Which Sections / 不同角色应该看哪几节

### dApp user / 普通 dApp 用户

Read these first:

优先看这些：

- Section 3: Browser Encryption Helper
- Section 7: Oracle + Encrypted Token
- Section 8: Oracle + Builtin Provider + Encrypted Params
- Section 10: Compute: Builtin Function + Encrypted Payload
- Section 14: Compute + WASM
- Section 15: Oracle + WASM
- Section 16: Oracle + WASM + Encrypted Params
- Section 22: Quick Combination Matrix

### Contract developer / 合约开发者

Read these first:

优先看这些：

- Section 2: Callback Shape
- Section 6: Neo N3 User Contract: Basic Oracle Request
- Section 18: PriceFeed Read: Neo N3
- Section 19: Feed Pair Discovery
- Section 20: Operator Feed Sync Behavior

### Operator / 运维与部署人员

Read these first:

优先看这些：

- Section 1: Routing Map
- Section 19: Feed Pair Discovery
- Section 20: Operator Feed Sync Behavior
- Section 21: Preferred Patterns
- Section 22: Quick Combination Matrix
- `docs/ENVIRONMENT.md`
- `docs/DEPLOYMENT.md`

### Security reviewer / 安全审计人员

Read these first:

优先看这些：

- Section 1: Routing Map
- Section 2: Callback Shape
- Section 11: Oracle + Custom JS Function
- Section 12: Oracle + Custom JS Function + Encrypted Params
- Section 13: Compute + Custom JS Function
- Section 14: Compute + WASM
- Section 15: Oracle + WASM
- `docs/ATTESTATION_SPEC.md`

## Fast Scenario Index / 场景快速索引

If your question is “how do I do X?”, use this shortcut table:

如果你的问题是“我到底该怎么做 X？”，先看这张捷径表：

| Goal / 目标                                                              | Start with / 先看  |
| ------------------------------------------------------------------------ | ------------------ |
| Trigger a one-off Oracle price callback / 发起一次 Oracle 价格回调       | Section 6, 7       |
| Call a private API with an encrypted token / 用加密 token 调私有 API     | Section 3, 7       |
| Keep function name and inputs encrypted / 把函数名和输入一起加密         | Section 3, 10      |
| Run a custom Oracle reduction inside TEE / 在 TEE 里跑自定义 Oracle 逻辑 | Section 11         |
| Run a stronger isolated workload / 使用更强隔离的执行模型                | Section 14, 15, 16 |
| Read on-chain feed state from my contract / 在用户合约里读取 pricefeed   | Section 18, 19     |
| Understand automatic feed synchronization / 理解自动 pricefeed 同步      | Section 20         |
| Decide between JS and WASM / 在 JS 与 WASM 之间做选择                    | Section 21         |
| Register automation jobs / 注册自动化任务                                | Section 23         |

## 1. Routing Map / 路由映射

The on-chain request only knows `requestType` and `payload`.
The relayer decides which worker route to use from `requestType`.

链上请求只知道 `requestType` 和 `payload`。
真正走哪个 worker 路由，是 relayer 根据 `requestType` 决定的。

| `requestType` example | Worker route          | Meaning                                     |
| --------------------- | --------------------- | ------------------------------------------- |
| `privacy_oracle`      | `/oracle/smart-fetch` | Privacy oracle fetch and optional reduction |
| `oracle`              | `/oracle/smart-fetch` | Same as above                               |
| `compute`             | `/compute/execute`    | Off-chain compute                           |
| `zkp_compute`         | `/compute/execute`    | Same compute route                          |
| `datafeed`            | `/oracle/feed`        | Operator-only feed sync / publish           |
| `vrf`                 | `/vrf/random`         | Randomness                                  |

Important:

重要：

- End users should not submit `datafeed` requests through the Oracle contract.
- Feed synchronization is an internal operator workflow.
- Users read the synchronized on-chain feed contracts directly.

- 终端用户不应通过 Oracle 合约提交 `datafeed` 请求。
- Feed 同步属于内部运维流程。
- 用户应直接读取链上已同步的 feed 合约数据。

## 2. Callback Shape / 回调形态

Every successful fulfill writes `result` bytes that contain UTF-8 JSON:

每次成功 fulfill 的 `result` 都是 UTF-8 JSON：

```json
{
  "version": "morpheus-result/v1",
  "request_type": "privacy_oracle",
  "success": true,
  "result": {
    "mode": "fetch",
    "target_chain": "neo_n3",
    "result": "2.508"
  },
  "verification": {
    "output_hash": "...",
    "attestation_hash": "...",
    "signature": "...",
    "public_key": "...",
    "tee_attestation": {
      "app_id": "...",
      "compose_hash": "...",
      "report_data": "...",
      "quote_hash": "..."
    }
  }
}
```

Important note:

重要说明：

- On-chain parsing of full JSON is usually too expensive.
- The normal pattern is: user contract stores raw callback bytes, and off-chain services parse them.
- If you want simpler on-chain consumption, design the custom Oracle/compute function to return a very small scalar result.

- 链上直接解析完整 JSON 通常太贵。
- 常见做法是：用户合约先保存原始 callback bytes，链下服务再解析。
- 如果你希望链上更容易消费，就让自定义 Oracle/compute 函数只返回很小的标量值。

## 3. Browser Encryption Helper / 浏览器端加密辅助

Use the Oracle public key first:

先取 Oracle 公钥：

```ts
async function fetchOracleKey() {
  const res = await fetch('/api/oracle/public-key');
  return res.json();
}
```

Encrypt any secret or confidential JSON patch.
Recommended format: `X25519-HKDF-SHA256-AES-256-GCM`.

加密任意 secret 或 confidential JSON patch：

```ts
async function encryptWithOracleKey(publicKeyBase64: string, plaintext: string) {
  const recipientBytes = Uint8Array.from(atob(publicKeyBase64), (char) => char.charCodeAt(0));
  const recipientKey = await crypto.subtle.importKey(
    'raw',
    recipientBytes,
    { name: 'X25519' },
    false,
    []
  );
  const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'X25519', public: recipientKey },
      ephemeral.privateKey,
      256
    )
  );
  const keyMaterial = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const info = new Uint8Array([
    ...new TextEncoder().encode('morpheus-confidential-payload-v2'),
    ...epk,
    ...recipientBytes,
  ]);
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: recipientBytes,
      info,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(plaintext)
    )
  );
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const tag = encrypted.slice(encrypted.length - 16);

  return btoa(
    JSON.stringify({
      v: 2,
      alg: 'X25519-HKDF-SHA256-AES-256-GCM',
      epk: btoa(String.fromCharCode(...epk)),
      iv: btoa(String.fromCharCode(...iv)),
      ct: btoa(String.fromCharCode(...ciphertext)),
      tag: btoa(String.fromCharCode(...tag)),
    })
  );
}
```

## 4. Node Encryption Helper / Node 端加密辅助

```js
import { webcrypto } from 'node:crypto';

async function encryptWithOracleKey(publicKeyBase64, plaintext) {
  const recipientBytes = Buffer.from(publicKeyBase64, 'base64');
  const recipientKey = await webcrypto.subtle.importKey(
    'raw',
    recipientBytes,
    { name: 'X25519' },
    false,
    []
  );
  const ephemeral = await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const epk = new Uint8Array(await webcrypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(
    await webcrypto.subtle.deriveBits(
      { name: 'X25519', public: recipientKey },
      ephemeral.privateKey,
      256
    )
  );
  const keyMaterial = await webcrypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const info = new Uint8Array([
    ...new TextEncoder().encode('morpheus-confidential-payload-v2'),
    ...epk,
    ...recipientBytes,
  ]);
  const aesKey = await webcrypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: recipientBytes,
      info,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(plaintext)
    )
  );
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const tag = encrypted.slice(encrypted.length - 16);
  return Buffer.from(
    JSON.stringify({
      v: 2,
      alg: 'X25519-HKDF-SHA256-AES-256-GCM',
      epk: Buffer.from(epk).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
      ct: Buffer.from(ciphertext).toString('base64'),
      tag: Buffer.from(tag).toString('base64'),
    })
  ).toString('base64');
}
```

## 5. Legacy EVM Example: Basic Oracle Request (archived) / 遗留 EVM 示例：基础预言机请求（已归档）

> Archived reference: this Solidity example predates the Neo N3 kernel path and will not compile against the current Neo N3 `MorpheusOracle`. Use Section 6 (Neo N3 C#) for new integrations.
>
> 已归档参考：此 Solidity 示例早于 Neo N3 kernel 路径，无法在当前 Neo N3 `MorpheusOracle` 上编译。新接入请使用第 6 节（Neo N3 C# 版本）。

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMorpheusOracleX {
    function requestFee() external view returns (uint256);
    function request(
        string calldata requestType,
        bytes calldata payload,
        address callbackContract,
        string calldata callbackMethod
    ) external payable returns (uint256 requestId);
}

contract UserConsumerX {
    IMorpheusOracleX public immutable oracle;

    struct OracleResult {
        string requestType;
        bool success;
        bytes result;
        string error;
    }

    mapping(uint256 => OracleResult) public callbacks;

    constructor(address oracleAddress) {
        oracle = IMorpheusOracleX(oracleAddress);
    }

    function requestNeoPrice() external payable returns (uint256 requestId) {
        uint256 fee = oracle.requestFee();
        require(msg.value == fee, "incorrect request fee");
        bytes memory payload = abi.encodePacked(
            "{\"provider\":\"twelvedata\",\"symbol\":\"NEO-USD\",\"json_path\":\"price\",\"target_chain\":\"neo_n3\"}"
        );

        requestId = oracle.request{value: fee}(
            "privacy_oracle",
            payload,
            address(this),
            "onOracleResult"
        );
    }

    function onOracleResult(
        uint256 requestId,
        string calldata requestType,
        bool success,
        bytes calldata result,
        string calldata error
    ) external {
        callbacks[requestId] = OracleResult({
            requestType: requestType,
            success: success,
            result: result,
            error: error
        });
    }
}
```

## 6. Neo N3 User Contract: Basic Oracle Request / Neo N3 用户合约：基础预言机请求

```csharp
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

[DisplayName("UserConsumerN3")]
public class UserConsumerN3 : SmartContract
{
    private static readonly byte[] PREFIX_ORACLE = new byte[] { 0x01 };
    private static readonly byte[] PREFIX_CALLBACK = new byte[] { 0x10 };
    // Outstanding requests this consumer issued, keyed by requestId, with the
    // requestType we expect the kernel to echo back.
    private static readonly byte[] PREFIX_PENDING = new byte[] { 0x11 };

    [Safe]
    public static UInt160 Oracle() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ORACLE);

    public static void SetOracle(UInt160 oracle)
    {
        Storage.Put(Storage.CurrentContext, PREFIX_ORACLE, oracle);
    }

    public static void DepositOracleCredits(BigInteger amount)
    {
        GAS.Transfer(Runtime.ExecutingScriptHash, Oracle(), amount, Runtime.ExecutingScriptHash);
    }

    public static BigInteger RequestNeoPrice()
    {
        string payloadJson = "{\"provider\":\"twelvedata\",\"symbol\":\"NEO-USD\",\"json_path\":\"price\",\"target_chain\":\"neo_n3\"}";
        ByteString payload = payloadJson;

        BigInteger requestId = (BigInteger)Contract.Call(
            Oracle(),
            "request",
            CallFlags.All,
            "privacy_oracle",
            payload,
            Runtime.ExecutingScriptHash,
            "onOracleResult"
        );
        // Record the request so OnOracleResult only honors callbacks we issued.
        Storage.Put(
            Storage.CurrentContext,
            Helper.Concat(PREFIX_PENDING, (ByteString)requestId.ToByteArray()),
            "privacy_oracle");
        return requestId;
    }

    public static void OnOracleResult(BigInteger requestId, string requestType, bool success, ByteString result, string error)
    {
        ExecutionEngine.Assert(Runtime.CallingScriptHash == Oracle(), "unauthorized caller");

        // Reject callbacks for requestIds we never issued (or already settled):
        // the lookup reverts on an unknown/forged id, and deleting the record
        // below makes a replay of the same id revert here too.
        ByteString pendingKey = Helper.Concat(PREFIX_PENDING, (ByteString)requestId.ToByteArray());
        ByteString expectedType = Storage.Get(Storage.CurrentContext, pendingKey);
        ExecutionEngine.Assert(expectedType != null, "unknown request id");
        ExecutionEngine.Assert(requestType == (string)expectedType, "request type mismatch");

        Storage.Put(Storage.CurrentContext, Helper.Concat(PREFIX_CALLBACK, (ByteString)requestId.ToByteArray()),
            StdLib.Serialize(new object[] { requestType, success, result, error }));
        Storage.Delete(Storage.CurrentContext, pendingKey);
    }
}
```

Fee note:

手续费说明：

- Neo N3 currently consumes prepaid Oracle credit at `0.01 GAS` per request.
- Neo N3 reference contracts use `requestFee()` and `msg.value`.

- Neo N3 现在每次请求消耗预存的 `0.01 GAS` Oracle credit。
- Neo N3 参考合约通过 `requestFee()` 和 `msg.value` 支付。

## 7. Oracle + Encrypted Token / 预言机 + 加密 token

Use this when only the auth token is secret.

当只有认证 token 需要保密时，使用这个组合。

Payload before encryption:

加密前明文：

```json
{
  "url": "https://api.example.com/private",
  "method": "GET",
  "headers": {
    "accept": "application/json"
  },
  "encrypted_token": "<ciphertext; hybrid envelope recommended>",
  "token_header": "Authorization",
  "json_path": "data.score",
  "target_chain": "neo_n3"
}
```

The caller contract still just passes UTF-8 JSON bytes.

调用方合约仍然只是传 UTF-8 JSON bytes。

## 8. Oracle + Builtin Provider + Encrypted Params / 内置 Provider + 加密参数

Use this when provider id is public, but some request-specific fields are secret.

当 provider 本身公开，但某些参数需要保密时，使用这个组合。

Plain public payload:

公开部分：

```json
{
  "provider": "twelvedata",
  "symbol": "NEO-USD",
  "target_chain": "neo_n3",
  "encrypted_params": "<ciphertext>"
}
```

Encrypted JSON patch example:

加密 patch 示例：

```json
{
  "json_path": "price",
  "headers": {
    "x-project-secret": "my-secret-header"
  }
}
```

## 9. Compute: Builtin Function / 内置计算函数

```json
{
  "mode": "builtin",
  "function": "math.modexp",
  "input": {
    "base": "2",
    "exponent": "10",
    "modulus": "17"
  },
  "target_chain": "neo_n3"
}
```

From contract, use `requestType = "compute"`:

合约侧用 `requestType = "compute"`：

```solidity
function requestModexp() external returns (uint256 requestId) {
    bytes memory payload = abi.encodePacked(
        "{\"mode\":\"builtin\",\"function\":\"math.modexp\",\"input\":{\"base\":\"2\",\"exponent\":\"10\",\"modulus\":\"17\"},\"target_chain\":\"neo_n3\"}"
    );
    requestId = oracle.request("compute", payload, address(this), "onOracleResult");
}
```

## 10. Compute: Builtin Function + Encrypted Payload / 内置计算 + 加密完整载荷

Public payload:

公开部分：

```json
{
  "encrypted_payload": "<ciphertext>"
}
```

Encrypted JSON patch:

加密 patch：

```json
{
  "mode": "builtin",
  "function": "math.modexp",
  "input": {
    "base": "2",
    "exponent": "10",
    "modulus": "17"
  },
  "target_chain": "neo_n3"
}
```

This is the cleanest pattern when even the function name should stay private.

如果连函数名都要保密，这是最干净的做法。

## 11. Oracle + Custom JS Function / 预言机 + 自定义 JS 函数

Important:

重要：

- This path only works if `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS=true`.
- By default it is disabled.

- 只有 `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS=true` 时这条路径才可用。
- 默认是关闭的。

```json
{
  "provider": "twelvedata",
  "symbol": "NEO-USD",
  "json_path": "price",
  "script": "function process(data, context, helpers) { return Number(data.price) > 2.5; }",
  "target_chain": "neo_n3"
}
```

## 12. Oracle + Custom JS Function + Encrypted Params / 预言机 + 自定义 JS + 加密参数

Public payload:

公开部分：

```json
{
  "url": "https://api.example.com/private",
  "method": "GET",
  "encrypted_token": "<ciphertext>",
  "encrypted_params": "<ciphertext>",
  "target_chain": "neo_n3"
}
```

Encrypted JSON patch:

加密 patch：

```json
{
  "headers": {
    "accept": "application/json"
  },
  "json_path": "profile.score",
  "script": "function process(data) { return data.profile.score > 80; }"
}
```

## 13. Compute + Custom JS Function / 计算 + 自定义 JS 函数

```json
{
  "mode": "script",
  "script": "function run(input) { return input.left + input.right; }",
  "entry_point": "run",
  "input": {
    "left": 2,
    "right": 3
  },
  "target_chain": "neo_n3"
}
```

## 14. Compute + WASM / 计算 + WASM

WASM is now the preferred path for stronger isolation.

WASM 现在是更推荐的路径，因为隔离性更强。

```json
{
  "wasm_base64": "<base64 wasm module>",
  "wasm_entry": "run",
  "input": {
    "left": 2,
    "right": 3
  },
  "target_chain": "neo_n3"
}
```

Current worker runtime defaults:

当前运行时默认值：

- `MORPHEUS_WASM_TIMEOUT_MS = 30000`
- `ORACLE_WASM_TIMEOUT_MS = 30000`
- `COMPUTE_WASM_TIMEOUT_MS = 30000`

## 15. Oracle + WASM / 预言机 + WASM

Use this when you want fetch + isolated compute in one trusted step.

当你想把“拉取数据 + 隔离计算”放在同一个 TEE 步骤里时，使用这个组合。

```json
{
  "provider": "twelvedata",
  "symbol": "NEO-USD",
  "json_path": "price",
  "wasm_base64": "<base64 wasm module>",
  "wasm_entry": "run",
  "target_chain": "neo_n3"
}
```

WASM input to the module is:

传给 WASM 模块的输入是：

```json
{
  "data": {
    "price": "2.508"
  },
  "context": {
    "target_chain": "neo_n3",
    "request_source": "morpheus-relayer:neo_n3",
    "upstream_status": 200
  }
}
```

## 16. Oracle + WASM + Encrypted Params / 预言机 + WASM + 加密参数

Public payload:

```json
{
  "url": "https://api.example.com/private",
  "encrypted_token": "<ciphertext>",
  "encrypted_params": "<ciphertext>",
  "target_chain": "neo_n3"
}
```

Encrypted JSON patch:

```json
{
  "headers": {
    "accept": "application/json"
  },
  "json_path": "secret.value",
  "wasm_base64": "<base64 wasm module>",
  "wasm_entry": "run"
}
```

## 17. PriceFeed Read: Neo N3 / 读取 Neo N3 PriceFeed

```solidity
interface IMorpheusDataFeedX {
    struct FeedRecord {
        string pair;
        uint256 roundId;
        uint256 price;
        uint256 timestamp;
        bytes32 attestationHash;
        uint256 sourceSetId;
    }

    function getLatest(string calldata pair) external view returns (FeedRecord memory);
}

contract FeedReaderX {
    IMorpheusDataFeedX public immutable feed;

    constructor(address feedAddress) {
        feed = IMorpheusDataFeedX(feedAddress);
    }

    function getNeoUsd() external view returns (uint256 price, uint256 ts, bytes32 attestationHash) {
        IMorpheusDataFeedX.FeedRecord memory record = feed.getLatest("TWELVEDATA:NEO-USD");
        return (record.price, record.timestamp, record.attestationHash);
    }
}
```

## 18. PriceFeed Read: Neo N3 / 读取 Neo N3 PriceFeed

```csharp
[Safe]
public static object[] ReadNeoUsd(UInt160 dataFeedHash)
{
    return (object[])Contract.Call(
        dataFeedHash,
        "getLatest",
        CallFlags.ReadOnly,
        "TWELVEDATA:NEO-USD"
    );
}
```

## 19. Feed Pair Discovery / 枚举 feed 列表

### Neo N3

```solidity
interface IMorpheusDataFeedX {
    function getPairCount() external view returns (uint256);
    function getPairByIndex(uint256 index) external view returns (string memory);
}
```

### Neo N3

```csharp
[Safe]
public static string[] GetAllPairs(UInt160 dataFeedHash)
{
    return (string[])Contract.Call(
        dataFeedHash,
        "getAllPairs",
        CallFlags.ReadOnly
    );
}
```

## 20. Operator Feed Sync Behavior / 运维侧 Feed 同步行为

This is an operator-only route. End users should not submit `datafeed` requests through the Oracle contract.

这是运维内部路由，终端用户不应通过 Oracle 合约提交 `datafeed` 请求。

```json
{
  "symbol": "NEO-USD",
  "target_chain": "neo_n3",
  "broadcast": true
}
```

This route is used by the relayer / operator automation layer and should not be exposed as a user contract flow.

这个路由属于 relayer / 运维自动化层，不应暴露成用户合约调用路径。

Current sync behavior:

当前同步行为：

- every 60 seconds, scan all configured feed pairs
- compare each pair with the current on-chain stored value for that storage pair
- only pairs whose change is greater than 0.1% are selected for on-chain publication
- if no pair crosses the threshold, no chain transaction is sent
- if multiple pairs cross the threshold, they are grouped into one batch transaction per chain

## 21. Preferred Patterns / 推荐组合

### Recommended for most production private logic / 生产中最推荐

- Oracle + encrypted token
- Oracle + encrypted params
- Compute builtin + encrypted payload
- Oracle + WASM
- Oracle + WASM + encrypted params

### Only if you explicitly accept the risk / 仅在明确接受风险时使用

- Oracle + custom JS script
- Compute + custom JS script

Those JS paths require:

这些 JS 路径要求：

- `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS=true`

## 22. Quick Combination Matrix / 快速组合矩阵

| Scenario                            | `requestType`    | Key payload fields                       |
| ----------------------------------- | ---------------- | ---------------------------------------- |
| Oracle + builtin provider           | `privacy_oracle` | `provider`, `symbol`, `json_path`        |
| Oracle + encrypted token            | `privacy_oracle` | `url`, `encrypted_token`, `token_header` |
| Oracle + encrypted params           | `privacy_oracle` | `url` or `provider`, `encrypted_params`  |
| Oracle + JS function                | `privacy_oracle` | `script`, optional `json_path`           |
| Oracle + JS + encrypted params      | `privacy_oracle` | `encrypted_params`, `script`             |
| Oracle + WASM                       | `privacy_oracle` | `wasm_base64`, `wasm_entry`              |
| Oracle + WASM + encrypted params    | `privacy_oracle` | `encrypted_params`, `wasm_base64`        |
| Compute builtin                     | `compute`        | `mode`, `function`, `input`              |
| Compute builtin + encrypted payload | `compute`        | `encrypted_payload` or `encrypted_input` |
| Compute JS script                   | `compute`        | `mode`, `script`, `entry_point`, `input` |
| Compute WASM                        | `compute`        | `wasm_base64`, `wasm_entry`, `input`     |
| Feed publish (operator-only)        | `datafeed`       | `symbol`, `target_chain`, `broadcast`    |
| Read feed on-chain                  | N/A              | call `getLatest(...)` on feed contract   |

## 23. Automation Registration / 自动化任务注册

Automation control requests also go through the Oracle gateway.

自动化控制请求也走 Oracle 网关。

Registration request type:

注册类型：

- `automation_register`
- `automation_cancel`

Supported trigger types:

支持的触发器类型：

- `one_shot`
- `interval`
- `price_threshold`

One-shot example:

一次性任务示例：

```json
{
  "trigger": {
    "type": "one_shot",
    "execute_at": "2026-03-11T00:00:00Z"
  },
  "execution": {
    "request_type": "privacy_oracle",
    "payload": {
      "provider": "twelvedata",
      "symbol": "NEO-USD",
      "json_path": "price",
      "target_chain": "neo_n3"
    }
  },
  "max_executions": 1
}
```

Interval example:

周期任务示例：

```json
{
  "trigger": {
    "type": "interval",
    "interval_ms": 600000,
    "start_at": "2026-03-11T00:10:00Z"
  },
  "execution": {
    "request_type": "compute",
    "payload": {
      "mode": "builtin",
      "function": "math.modexp",
      "input": { "base": "2", "exponent": "10", "modulus": "17" },
      "target_chain": "neo_n3"
    }
  }
}
```

Note:

说明：

- if you plan to cancel an interval automation before its first execution, set `start_at` in the future
- otherwise the scheduler may legitimately queue the first execution before your cancel request lands

- 如果你打算在第一次执行前取消 interval 自动化，请把 `start_at` 设为未来时间
- 否则调度器可能会在取消请求到达前，先合法地排队第一次执行

Price-threshold example:

价格阈值触发示例：

```json
{
  "trigger": {
    "type": "price_threshold",
    "feed_chain": "neo_n3",
    "pair": "TWELVEDATA:NEO-USD",
    "comparator": "cross_above",
    "threshold": "300",
    "cooldown_ms": 300000
  },
  "execution": {
    "request_type": "privacy_oracle",
    "payload": {
      "url": "<production-api-url>",
      "target_chain": "neo_n3",
      "encrypted_params": "<ciphertext>"
    }
  }
}
```

Fee model:

手续费模型：

- each automation execution queues a normal Oracle request
- every queued execution consumes the standard `requestFee`
- Neo N3 uses prepaid GAS credits already stored in the Oracle contract
- Neo N3 uses prepaid fee credits through `depositFeeCredit`

- 每次自动化执行都会排队成一个普通 Oracle 请求
- 每次排队执行都会消耗标准 `requestFee`
- Neo N3 直接消耗 Oracle 合约里的预存 GAS credit
- Neo N3 通过 `depositFeeCredit` 预存手续费

Validated on Neo N3 mainnet:

已在 Neo N3 主网验证：

- one-shot register callback: `request_id=55`
- one-shot queued execution callback: `request_id=56`
- interval register callback: `request_id=57`
- automation cancel callback: `request_id=58`
- one-shot job reached Supabase status `completed`
- cancelled interval job reached Supabase status `cancelled`

## 24. Role-Based Playbooks / 按角色的工作流建议

### Playbook A: dApp user who just wants a private answer / 只想拿到一个隐私结果的 dApp 用户

Recommended flow:

推荐流程：

1. Read the Oracle public key from the on-chain Oracle contract.
   先从链上 Oracle 合约读取 Oracle 公钥。
2. Encrypt only the secret token if the rest of the request is public.
   如果只有 token 保密，就只加密 token。
3. Encrypt the whole JSON patch if even the function or parameters are sensitive.
   如果连函数名或参数都敏感，就加密整段 JSON patch。
4. Prefer Oracle + WASM over Oracle + custom JS.
   优先使用 Oracle + WASM，不要优先用 Oracle + 自定义 JS。
5. Parse callback bytes off-chain and only store critical booleans / scores on-chain.
   callback bytes 尽量链下解析，链上只保存关键布尔值 / 分数。

Best matching examples:

最匹配的示例：

- Section 7
- Section 8
- Section 15
- Section 16

### Playbook B: contract developer who needs composable callbacks / 需要可组合 callback 的合约开发者

Recommended flow:

推荐流程：

1. Keep your callback contract minimal.
   让 callback consumer 保持最小化。
2. Store raw callback bytes first.
   先把原始 callback bytes 存下来。
3. Avoid expensive on-chain JSON parsing.
   不要在链上解析复杂 JSON。
4. If you need simple on-chain branching, design the worker result to be a scalar string / bool.
   如果需要链上分支判断，就让 worker 返回标量字符串 / 布尔值。

Best matching examples:

最匹配的示例：

- Section 2
- Section 5
- Section 6
- Section 17
- Section 18

### Playbook C: operator who wants stable production usage / 想要稳定生产运行的运维

Recommended flow:

推荐流程：

1. Default to builtin providers or WASM.
   默认优先 builtin provider 或 WASM。
2. Keep `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS` unset unless you truly need JS.
   除非真的需要 JS，否则保持 `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS` 不设置。
3. Keep feed publication explicit and controlled.
   feed 发布要明确控制，不要随便暴露触发入口。
4. Watch relayer retries and dead letters.
   持续看 relayer retry 和 dead letter。
5. Tune WASM timeout via env, not code.
   WASM 超时通过环境变量调，不要改代码。

Best matching examples:

最匹配的示例：

- Section 14
- Section 15
- Section 20
- `docs/ENVIRONMENT.md`

### Playbook D: security-first integration / 安全优先集成

Recommended flow:

推荐流程：

1. Prefer builtins or WASM.
   优先 builtin 或 WASM。
2. Avoid custom JS unless isolated and explicitly enabled.
   除非明确开启且接受风险，否则避免自定义 JS。
3. Use encrypted token for secret headers, encrypted payload for secret logic.
   secret header 用 `encrypted_token`，secret logic 用 `encrypted_payload` / `encrypted_params`。
4. Keep callbacks allowlisted and contracts minimal.
   保持 callback allowlist 严格，consumer 合约保持最小。
5. Verify TEE attestation off-chain on every critical flow.
   关键流程都做链下 attestation 验证。

Best matching examples:

最匹配的示例：

- Section 7
- Section 10
- Section 14
- Section 15
- Section 16
