# T03 完成记录 — chain 适配层与持久层（Rust 迁移）

> 更新时间：2026-09-04 ｜ 状态：**T03 全部完成，workspace 1106 passed / 0 failed**
> 依据：docs/rust-migration/ARCHITECTURE.md §1.1/§2/§6（T03 = 链适配层 + 持久层）
> 本文由交接报告转为完成记录；§4 的坑位清单与 §6 验收命令仍然有效。

---

## 1. 全局上下文（两条并行工作流）

本工作区（D:\Git\neo-os）有两条独立工作流，均已完成：

### 工作流 A：安全修复（完成，见 docs 三份报告）

- P0 9 项修复（fura 缓存、k8s SSRF、web 脚本 Global scope、钱包会话态、USE_BLOCK_TX、合约时间锁、relay 确认）—— 全部完成
- 补充审计 11 项发现全部修复（nitro-worker fail-closed、nginx CF 围栏、multisig 创建修复、relayer nonce 去重等）
- 25+ 合约时间锁化（minigames 19 个 + miniapps 6 个 + SelfLoan + MorpheusOracle + NeoDIDRegistry + OracleCallbackConsumer + MorpheusDataFeed）
- 既有测试失败全部修复；neo-express 真链验证（AuditLock 夹具：未授权拒绝/时锁阻断/fastfwd 过期执行/一次性消费全部通过）
- 报告：`neo-os-contracts/docs/{custody-upgrade-permissions,security-audit-glm53,neo-express-contract-audit}-2026-08-2*.md`

### 工作流 B：Rust 迁移 T03（已完成）

- **T03a**：core n3_tx 扩展 + `neo-os-chain-n3` crate 全量（41 测试）
- **T03b**：`neo-os-chain-evm`（8 测试，含 5 个 neox_parity 向量）+ `neo-os-relayer-store`（8 parity 测试）
- 向量导出器：`n3_extension` family 已并入 `scripts/export-rust-vectors.mjs`（14 个 family 全部 `--check` 通过）

---

## 2. T03a（完成）

### 2.1 core `n3_tx` 扩展（`crates/neo-os-core/src/n3_tx.rs`）

新增（全部从仓库自带 neon-js 收割字节锁定，`tests/vectors/n3_extension.json`）：

- `ContractParam::HexBytes` — `byteArray(HexString.fromHex(hex,true))`：hex 解码后原样字节
- `ContractParam::Hash160` — 地址或 0x-hex → **发射时统一反转**（非对称夹具 `0102…1314 → 1413…0102` 钉死方向）
- `ContractParam::Boolean/Any` — PUSHT(08)/PUSHF(09)/PUSHNULL(0b)
- `emit_byte_string` 支持 PUSHDATA2/4（>255 字节自动切换）
- `Witness` + `serialize_signed(witnesses)` + `hash_display()` —— **实测 neon-js `hash()` = `reverseHex(sha256(serialize(false)))`，witness 不参与哈希**（这是向量逼出来的修正，勿改回 serialize(true)）
- `hash160`（ripemd160∘sha256，BE）、`verification_script_single_sig`、`script_hash_from_public_key`/`script_hash_from_address`/`address_from_script_hash`（**均返回 LE display form**，neon-js 约定）
- `create_invoke_script` 签名改为 `Result<Vec<u8>, N3EncodeError>`（无效 hex 抛错，对齐 JS throw）——调用点已全部更新

### 2.2 `neo-os-chain-n3` crate（~1.9k 行 + 41 测试全绿）

| 模块                    | 内容                                                                                                                                                           | 测试                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `rpc.rs`                | 注入 transport、URL failover + known-good promotion、JS 错误串逐字对齐、7 个类型化方法                                                                         | 绿                     |
| `scan.rs`               | 栈项解码（hex/base64/auto）、kernel/legacy 通知形态、≥14/≥12 记录形态（settled 过滤：14-field 门在 index 10/12/13，12-field 门在 index 8/10/11）、4 个扫描入口 | 绿                     |
| `tx.rs`                 | 注入 NonceSource（CSPRNG）/Waiter、两段签名（费前/费后）、20% headroom、custody key-swap 检测（hash160 需 **reverse 成 LE display** 再比对）、confirm 轮询四态 | 集成于 tx_broadcast.rs |
| `custody.rs`            | key 身份/sign-raw/sign-transaction；2xx 但 `allowed:false` 也是拒绝                                                                                            | 绿                     |
| `ssrf.rs`               | http/https 强制 + resolve-then-classify + 十进制/十六进制/八进制 IPv4 绕过检测；resolver 注入（测试离线）                                                      | 绿                     |
| `concurrency.rs`        | `mapWithConcurrency`：输入序保持、fail-fast、跳过排队项                                                                                                        | 绿                     |
| `tests/tx_broadcast.rs` | 广播 happy path、FAULT 塑形、key-swap、confirm 四态                                                                                                            | 9/9 绿                 |

注意：`HttpTransport` trait 与 `&T` blanket impl 定义在 chain-n3、chain-evm、relayer-store **各自**的 lib.rs（三个 crate 未互相依赖）。

---

## 3. T03b（完成）

### 3.1 `neo-os-chain-evm`（全绿）

`Cargo.toml`（sha3 做 keccak，**无 k256/alloy** —— FulfillmentSigner 是 enclave seam，主机侧生产签名被禁）、`lib.rs`（HttpTransport + &T blanket）、`abi.rs`（head/tail ABI codec）、`rpc.rs`（EvmRpcClient：transport-vs-deterministic 错误分类 + failover）、`fulfill.rs`（neox digest + EIP-191 seam + revert 词表 + confidential 解码）、`scan.rs`（NeoXEvent，STATUS_PENDING=1 过滤，ZeroAddress→空）、`custody.rs`/`tx.rs`、`tests/neox_parity.rs` + `tests/vectors/neox_digest.json`（8 个 ethers 收割向量）。

8/8 测试全绿（此前交接记录中的 3 个失败均已消除：向量在 `tests/vectors/` 路径正确；abi_encode 对齐问题为陈旧测试二进制，干净重编后消失）。

### 3.2 `neo-os-relayer-store`（完成，~1.8k 行 + 8 parity 测试）

源：`workers/morpheus-relayer/src/persistence.js` + `queue.js`。

```
crates/neo-os-relayer-store/
├── src/
│   ├── lib.rs         # HttpTransport trait + &T blanket（注入式，测试零网络）
│   ├── supabase.rs    # REST 客户端：Prefer 头（resolution/return=representation）、
│   │                  # on_conflict、sanitize_for_postgres（剥 \u0000）、双档退避
│   │                  # （quota 5min / connectivity 30s，错误串分类对齐 persistence.js）
│   ├── jobs.rs        # 6 表操作：upsert/insert-if-absent/patch/claim(or=(...) 乐观并发)/
│   │                  # fetch-by-statuses/quarantine-below-request-id（数值比较 + chunk PATCH）、
│   │                  # automation 与 feed snapshot 同族
│   ├── queue.rs       # claim 决策四态（Granted/Conflict/BackoffSkip/Unavailable）、
│   │                  # is_durable_queue_ready_job、manual-action HMAC-SHA256
│   │                  # （canonical: ['morpheus-manual-action-v1', action, network, eventKey,
│   │                  #   stableStringify(event)].join('\n')；stable_stringify 在 core）
│   └── state_file.rs  # 原子写（tmp+rename）
└── tests/store_parity.rs  # 8 测试：NUL 清洗、错误分类退避、REST 头塑形、S4 HMAC 签发/校验、
                           # claim 乐观并发不双取、request-floor 隔离、原子写、就绪判定
```

关键语义（与 JS 逐字对齐）：

- 错误分类：quota（exceed_db_size_quota/402）→ 5min 退避；connectivity（pgrst002/502/503/504/timeout/econnreset/…）→ 30s 退避；二者都算 transient
- claim 请求：PATCH `return=representation` + `or=(status.in.(...),and(status.eq.X,updated_at.lt.Y))`；返回行→Granted，空→Conflict
- 多实例 fail-closed：backoff 期间默认 BackoffSkip（不本地 claim）
- S4 HMAC 挂 worker_response.manual_action_sig；hydration 校验失败则跳过该行

### 3.3 向量导出器（完成）

`n3_extension` family 已并入 `scripts/export-rust-vectors.mjs`（原 `workers/morpheus-relayer/harvest-n3-extension-vectors.mjs` 已删除并入）。产出 `crates/neo-os-core/tests/vectors/n3_extension.json`，17 个向量值与原收割输出逐字一致（`family` 键为导出器惯例，Rust 侧 `serde_json::Value::get` 天然兼容）。`node scripts/export-rust-vectors.mjs --check` 14 个 family 全过。

---

## 4. 已知坑（前车之鉴，读后省一小时）

1. **不要用 python heredoc 写源码**：shell 转义会破坏 `\"` 与 `\n`。改用 Write/Edit 工具（Mimosa hook 也强制如此）。
2. **hex 常量手数必错**：凡断言 40/42 字符的测试，期望值一律从向量 JSON 切片派生（见 n3_tx_extension.rs 的 `from_vector` 写法）。
3. **base58 地址 payload 是 LE**：`script_hash_from_address` 返回 LE display（neon-js 约定），`Hash160` 参数发射 wire 字节（地址输入 = payload 原样，hex 输入 = 反转）。
4. **neon-js `ContractParam.array()` 会走 JSON 往返**：元素含 HexString 对象即炸。收割逻辑直接把参数喂给 `createScript` 顶层 args。
5. **neo-express**：DBFT 上限在 `.neo-express` 每节点 `dbft-settings.max-block-system-fee`（当前 1500 GAS）；`neoxp stop` 优雅停（taskkill /F 丢状态）；`fastfwd N --timestamp-delta 86401000` 才能过 24h 时锁（默认 timestamp 不走）。
6. **global.json**：app 仓 rollForward 已放宽为 patch（本机 SDK 10.0.111 vs pin 10.0.108）；如需严格 pin 先装 SDK。
7. **explorer 依赖**：bun.lock 是权威；npm 装不下（EOVERRIDE 已修但 package-lock 未提交）。
8. **Rust 测试报"不可能"错误先怀疑陈旧二进制**：chain-evm 的 abi_encode 对齐报错在干净重编后消失（§3.1）。

## 5. 回归基线（当前）

- services workspace：**1106 passed / 0 failed**（chain-n3 41、chain-evm 8、relayer-store 8、core n3_tx 18 含扩展 10）
- explorer 3249、admin 377、app 343、minigames 264、miniapps 60、fura/web/contracts 全绿
- neo-express 实例：`neo-express-audit/`（AuditLock + GasBox 已部署，安全测试全过）

## 6. 验收命令

```bash
cd D:\Git\neo-os\neo-os-services
cargo build --workspace
cargo test --workspace          # 预期：全绿（1106 passed / 0 failed）
node scripts/export-rust-vectors.mjs --check   # 预期：all vector files match the JS oracle
```

## 7. 遗留（非代码项，需用户/运维决策）

- 已部署合约升级到时间锁化 NEF、owner→multisig 治理迁移、SelfLoan 硬编码 EOA `NR3E4D8…` 替换、fura TRUSTED_PROXY_CIDRS 收窄
- T04（enclave FulfillmentSigner 落地）为主机侧签名禁令的最终闭环；当前 chain-evm 的 seam 已就位
- Better Harness 审计（`.qoder/better-harness/2026-09-04/`）列出的部署侧动作（密钥轮换、DR 演练、Dependabot、CI Windows 可移植性）不在 T03 范围
