# NeoOS Services vs Chainlink CRE 对比分析与升级建议

> 目标：在**保持中心化服务**的前提下，让 NeoOS Services 的开发者体验与能力维度接近 Chainlink CRE。
> 调研日期：2026-08。信息来源：neo-os-services 仓库代码/文档（file:line 引用）、Chainlink 官方文档与公告（URL 引用）。

## 执行摘要

1. **路线认知校准**：Chainlink CRE 并未把 DECO（TLS 三方证明）整合进来——CRE 的隐私栈是 **TEE + enclave attestation + Vault DON 加密 secrets**（`docs.chain.link/cre/privacy`），`chain.link/deco` 已 404。NeoOS 的 Nitro/TDX CVM + attestation envelope 与 CRE 现行路线**同源同向**，无需补 DECO 课。
2. **最大差距不是隐私计算，而是开发者自助能力（DX）**：CRE 的核心卖点是 "self-serve"——开发者用 CLI 自行部署 workflow、自行管理 secrets、本地 simulate、跨链部署。NeoOS 目前是"平台预置 9 个 workflow + 开发者只能写链上合约发起请求"，无 SDK/CLI、无自助注册、secrets 无管理能力。
3. **可以借鉴的 80% 是 CRE 的编程模型与 DX 外壳**（Workflow/Handler/Trigger/Callback、CLI、simulate、secrets API、templates、observability），用 Cloudflare + Supabase + TEE CVM 的中心化组合替换其 DON/BFT 底座即可。
4. **不建议借鉴的部分**：多节点共识、threshold encryption、链上 registry——这些是去中心化负担，与中心化定位冲突，TEE attestation 已提供等价信任锚。

---

## 一、认知校准：CRE 是什么（vs 记忆中的 Functions + DECO）

- CRE（Chainlink Runtime Environment，2024-10 SmartCon 公布，2026 已 mainnet 上线）是 Chainlink 平台级重构：把预打包服务（Functions/VRF/Automation）拆解为**模块化 Capability**，开发者**自助组合**为 Workflow。
- 核心概念（现行文档术语）：`Workflow`（编译后的 WASM 二进制）= `Handler`(trigger, callback) + `Trigger`（cron / HTTP / EVM log）+ `Callback`（业务逻辑，stateless）。`Workflow DON` 监视 trigger 并编排；`Capability DON` 执行具体能力（HTTP Fetch、EVM Read/Write、Solana Write、Triggers），**每个 capability 一个独立 DON（microservice 化）**；结果经 **BFT 共识**聚合为单一验证结果，生成 DON 签名的 `Report`（上链或离线投递）。
- 隐私能力（现行）：`Confidential Workflows`（整个 callback 在 enclave 内执行，`HandlerInTee` + `TeeRuntime`，信任来自 enclave attestation 而非共识）与 `Confidential HTTP`；secrets 存于 `Vault DON`（"threshold-encrypted secrets, designed to release them only to an attested enclave"），enclave 内 `runtime.getSecret()` 动态解密。
- **DECO 不在 CRE 文档中**：现行 CRE 隐私边界明示"不保护 workflow 源码/已部署二进制"，多 workflow 共享 enclave（Wasmtime 隔离），per-workflow 隔离是 future enhancement。
- 来源：https://docs.chain.link/cre 、https://docs.chain.link/cre/key-terms 、https://docs.chain.link/cre/concepts/consensus-computing 、https://docs.chain.link/cre/privacy 、https://docs.chain.link/cre/concepts/confidential-workflows 、https://blog.chain.link/introducing-chainlink-runtime-environment/

## 二、NeoOS Services 现状速览

- 拓扑：Cloudflare edge gateway → control plane（Queues/Workflows 编排）→ Supabase（持久化）→ **TEE 执行平面**（Oracle CVM + DataFeed CVM，Intel TDX）→ relayer → Neo N3 MiniApp OS kernel inbox（`docs/ARCHITECTURE.md`）。
- 计算：20+ built-in 函数（`POST /compute/execute`，`docs/BUILTIN_COMPUTE.md`）+ **script 模式**（内联 JS，`node:vm` 沙箱：createContext + compileFunction + codegen-disabled realm + deep-clone 防逃逸，`workers/nitro-worker/src/platform/script-child.cjs`）。
- 机密：客户端 `X25519-HKDF-SHA256-AES-256-GCM` 密封 → TEE 内解密；`encrypted_token/payload/params` + `encrypted_*_ref`（ciphertext 存 Supabase `morpheus_encrypted_secrets`）；结果带 TDX attestation envelope（`report_data` 前 32 字节绑定 `output_hash`，`docs/ATTESTATION_SPEC.md`）。
- 触发：链上 async request + automation（interval/threshold，automation handler 在 TEE 执行，relayer 负责触发与结果广播，不在 TEE 内解密执行）。
- Workflow catalog：平台静态 9 个 workflow，无参数 schema、无自助注册（`apps/web/public/morpheus-runtime-catalog.json`）。
- 计费：链上 0.01 GAS 预存 fee credit。

## 三、对比矩阵

| 维度     | Chainlink CRE                                                                       | NeoOS Services                                                                                                                                                               | 差距评级                      |
| -------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 编程模型 | Workflow(WASM) = Handler + Trigger + Callback，开发者写 Go/TS                       | built-in 函数 + 内联 JS script（node:vm），平台预置 workflow                                                                                                                 | 🔴 大                         |
| 代码部署 | **开发者自助**：CLI create/deploy/activate/pause/delete，版本化                     | 平台静态 JSON，无自助注册 API                                                                                                                                                | 🔴 大                         |
| 触发机制 | cron / HTTP / EVM log 自助配置（cron≥30s、HTTP 1/60s）                              | 链上 request + automation interval/threshold                                                                                                                                 | 🔴 大                         |
| Secrets  | Vault DON + CLI（1Password 集成）+ `getSecret()` + 配额管理                         | 客户端加密 + encrypted ref；**无轮换（RLS 仅 select/insert）、无 TTL、无 UI**；store API 实际要求 admin key（与文档矛盾，`apps/web/app/api/confidential/store/route.ts:56`） | 🔴 大                         |
| 机密执行 | Confidential Workflows（整个 handler 进 enclave）+ Confidential HTTP                | 单次请求进 TEE（fetch/compute/script）+ attestation envelope                                                                                                                 | 🟡 中                         |
| 结果验证 | BFT 共识聚合 + DON 签名 Report（在线/离线验证）                                     | TDX attestation + N3 签名 + `/verifier` UI                                                                                                                                   | 🟢 同向（中心化等价物已存在） |
| 本地开发 | `cre workflow simulate`：本地跑 WASM + 真实 API 调用                                | 无模拟器；本地只能裸跑 worker（无 attestation）                                                                                                                              | 🔴 大                         |
| SDK/CLI  | CLI + Go/TS SDK + AI agent skills + llms-full.txt                                   | 无 SDK/CLI；加密 helper 以 copy-paste 代码分发                                                                                                                               | 🔴 大                         |
| 模板生态 | Templates Hub（prediction market、stablecoin+PoR+ACE 等）                           | 无 workflow 模板（但拥有 80+ miniapps/minigames 业务资产可沉淀：`neo-os-miniapps/apps` 56 个、`neo-os-minigames/apps` 28 个）                                                | 🟡 中                         |
| 可观测性 | CLI logs + CRE UI logs/events                                                       | operator-only API（`/api/relayer/*` 需 admin）；开发者只能读链                                                                                                               | 🔴 大                         |
| 计费     | Early Access 无公开定价；onchain registry（gas）或 private registry（免费但中心化） | 链上 0.01 GAS 预存；无用量仪表盘/配额                                                                                                                                        | 🟡 中                         |
| 跨链     | EVM + Solana + 多链（"One platform, any chain"）                                    | 仅 Neo N3（`docs/USER_GUIDE.md:34`）                                                                                                                                         | 🟡 视定位                     |
| 配额体系 | 明确 service quotas（WASM≤100MB、超时5min、HTTP 5次/执行等）                        | 有运行时限额（`docs/ASYNC_PRIVACY_ORACLE_SPEC.md` Runtime Limits）但无公开 quota 文档                                                                                        | 🟡 中                         |
| 请求体验 | Report 直接投递（上链或离线），无需轮询 requestId                                   | 链上 requestId 不在 relay 响应中，需轮询 application log（"the most common integration mistake"，`apps/web/app/docs/quickstart/page.tsx:158-163`）                           | 🔴 大                         |

## 四、核心差距诊断（为什么体验差一个时代）

1. **开发者无法自助发布计算**。CRE 的开发者是"平台用户"（deploy code on the platform，无需改链上合约）；NeoOS 的开发者是"合约开发者"（必须部署 N3 回调合约、轮询 requestId）。这决定了集成成本一个在分钟级、一个在天级。
2. **Trigger 单一**。CRE 的 workflow 可被 cron/HTTP/链上事件触发；NeoOS 只有链上 request 入口 + 平台侧 automation，开发者不能自助建定时任务或 HTTP 入口。
3. **Secrets 停留在"传参"而非"资源"**。CRE 的 secret 是 workflow 绑定的托管资源（部署时绑定、运行时 getSecret、CLI 管理）；NeoOS 的 encrypted ref 是临时密文，无生命周期管理。
4. **无本地回路**。CRE 的 simulate 让开发者在几分钟内验证逻辑；NeoOS 必须真金白银跑 testnet 甚至 mainnet。
5. **可观测性面向运维而非开发者**。CRE 每个 workflow 有 logs/events；NeoOS 的 jobs API 全部 operator-only。

## 五、升级建议清单（保持中心化）

> 中心化映射原则：Workflow DON → Cloudflare Queues/Workflows；Capability DON → TEE CVM 模块 lane；Vault DON → Supabase ciphertext + TEE 内解密；Consensus/Report → TEE attestation + 平台签名（单一信任根）。

### P0 — 体验对齐 CRE 的关键动作

**1. 开发者自助 Workflow 平台**（借鉴：CRE Workflow/Handler/Trigger/Callback 模型）

- 新建 workflow registry：`POST/PUT/DELETE /api/workflows`，字段 = id、handler（JS，复用现有 node:vm 沙箱与 `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS` 治理）、trigger（cron/HTTP/链上事件）、绑定 secrets、版本号、状态机（draft/active/paused/deleted）。
- 执行语义对齐 CRE：trigger 到达 → control plane 入队 → TEE CVM 执行 handler → 回调 = 链上 inbox 写入或 HTTP webhook（离线投递等价物）。
- 中心化信任声明：结果附 TEE attestation envelope（现有 `verification` 结构复用），作为"单一信任根共识"的等价物，并在文档中声明与 CRE 的共识差异。
- 收益：开发者集成成本从"写合约+轮询"降到"部署 workflow+平台投递"。

**2. Secrets 现代化**（借鉴：Vault DON + `getSecret()`）

- 修复 `POST /api/confidential/store` 的 admin-only 与文档矛盾；提供 per-project secrets CRUD + **轮换（update/delete）** + TTL + web UI vault。
- handler 运行时新增 `getSecret(name)` helper（TEE 内解密注入，明文不出 enclave），对齐 CRE `runtime.getSecret()` 语义。
- 保持客户端加密信封不变（X25519 envelope 已是好设计）。

**3. TypeScript SDK + CLI**（借鉴：CRE CLI + Go/TS SDK）

- `@neoos/sdk`：内置 `encryptJsonWithOraclePublicKey`（结束 copy-paste 时代）、请求构建、回调 envelope 解析、attestation 验证、workflow 部署客户端。
- `neoos` CLI：`workflow init/create/deploy/simulate/logs/pause`、`secrets set/list/rotate`。

**4. 本地模拟器**（借鉴：`cre workflow simulate`）

- `neoos workflow simulate`：直接复用 `script-child.cjs` 沙箱在本地跑 handler；可选真实 API 调用（标注"非 TEE 执行、无 attestation"）；本地 mock 上游。
- 与 apps/web Dashboard Workbench 打通，生成可直接提交的请求 payload。

**5. 开发者可观测性**（借鉴：CRE logs/events + 修复 requestId 坑）

- 按 project 隔离的请求状态查询 API + UI（复用 `morpheus_requests` 的 select_own RLS）；workflow 级 logs/events 流（Supabase Realtime）。
- relay 响应回传 `requestId`，消除轮询 application log 的集成陷阱。

### P1 — 体验增强

**6. Workflow 参数 JSON Schema + 类型化 handler**：catalog 增加 schema 与部署时校验，TS SDK 据此生成类型（对齐 CRE 的类型化 handler）。
**7. Templates Hub**（借鉴：docs.chain.link/cre-templates）：把 80+ miniapps/minigames 的成熟模式（价格、随机、定时、跨合约编排）沉淀为 `neoos workflow create --template <name>` 模板。
**8. Capability 扩展**：handler 内多次 HTTP 编排（参考 CRE 5 次/执行配额）、链上读写 capability（为未来多链预留）、LLM capability（对齐 CRE 官方用例：AI 审计防火墙、风控）。
**9. 计费透明化**：offchain 用量仪表盘 + per-project quota（参考 CRE service quotas 的显式化），链上 0.01 GAS 预存保留。

### P2 — 战略方向（可选，视定位）

**10. 多链支持**：CRE 的 "any chain" 是其最大卖点；若 NeoOS 定位 Neo N3 生态则降优先级，可作为 capability 层预留（`target_chain` 字段已存在于请求 payload 与 secrets schema：`docs/ASYNC_PRIVACY_ORACLE_SPEC.md:135`、`db/services/migrations/0001_morpheus_schema.sql`）。
**11. WASM 执行升级**：isolated-vm/QuickJS 替换裸 `node:vm`（对齐 CRE 的 Wasmtime 隔离声明与 100MB WASM 配额），并公开 per-workflow 隔离边界。
**12. Confidential Workflow 模式**（借鉴：`HandlerInTee`）：支持整个 handler（含跨请求状态）驻留 TEE，解锁做市/撮合/策略类场景；同时**照抄 CRE 的诚实边界声明**（不保护源码/二进制、多 workflow 共享 enclave）。

## 六、不建议借鉴（去中心化负担）

- 多节点 BFT 共识 / 多 DON 编排：与中心化定位冲突；TEE attestation + 平台签名已提供"可信结果"锚。
- Threshold-encrypted secrets（Vault DON）：需要多节点门限；中心化场景客户端加密信封 + TEE 解密足够，KMS 可选增强。
- 链上 workflow registry（Ethereum gas 注册）：中心化用 Supabase registry 即可；CRE 自己都承认 private registry "centralized and offchain"。
- DECO TLS 三方证明：已不在 CRE 现行路线，工程复杂且收益被 TEE 覆盖。
- CRE 的 Early Access 模式、confidential invite-only：作为反例——中心化服务的优势恰恰是**更快开放自助能力**，不应学其审批准入。

## 七、落地优先级速查

| 优先级 | 动作                                                  | 对应 CRE 概念                 | 预计工作量    |
| ------ | ----------------------------------------------------- | ----------------------------- | ------------- |
| P0-1   | 自助 workflow registry + 状态机                       | Workflow 部署生命周期         | 2-3 人月      |
| P0-2   | secrets CRUD/轮换/TTL/UI + getSecret()                | Vault DON + runtime.GetSecret | 1 人月        |
| P0-3   | TS SDK + neoos CLI                                    | CRE CLI + SDK                 | 1-2 人月      |
| P0-4   | neoos workflow simulate                               | cre workflow simulate         | 0.5-1 人月    |
| P0-5   | 开发者请求状态 API/UI + requestId 修复                | CRE logs/events               | 1 人月        |
| P1     | schema 校验、Templates、capability 扩展、quota 仪表盘 | —                             | 各 0.5-2 人月 |
| P2     | 多链、WASM 升级、Confidential Workflow                | —                             | 视战略        |

## 附录 A：neo-os 关键证据索引

- 拓扑与信任边界：`docs/ARCHITECTURE.md`；请求/机密/结果模型：`docs/ASYNC_PRIVACY_ORACLE_SPEC.md`
- built-in 计算目录：`docs/BUILTIN_COMPUTE.md`
- attestation 模型：`docs/ATTESTATION_SPEC.md`
- JS 沙箱：`workers/nitro-worker/src/platform/script-child.cjs`、`script-runner.js`
- workflow catalog：`apps/web/public/morpheus-runtime-catalog.json`、`packages/shared/src/workflow-catalog.js`
- secrets 表/RLS：`db/services/migrations/0001_morpheus_schema.sql`、`0002_morpheus_policies_and_seeds.sql`
- 已知短板：`docs/USER_GUIDE.md:34`（仅 N3）、`docs/EXAMPLES.md:39`、`workers/nitro-worker/src/platform/script-source.js:74`（script_ref 仅 neo_n3）、`docs/ENVIRONMENT.md:354-356`（自定义 JS 默认关闭）、`apps/web/app/docs/quickstart/page.tsx:158-163`（requestId 坑）

## 附录 B：CRE 关键来源索引

> 以下页面均于 2026-08 实际访问核实；其中 `docs.chain.link/cre/architecture`、`docs.chain.link/cre/decryption-engine`、`chain.link/deco` 均已 404（已从现行文档移除）。

- 定位与概念：https://docs.chain.link/cre 、https://docs.chain.link/cre/key-terms
- 共识计算：https://docs.chain.link/cre/concepts/consensus-computing
- 隐私与 Confidential Workflows：https://docs.chain.link/cre/privacy 、https://docs.chain.link/cre/concepts/confidential-workflows
- 配额：https://docs.chain.link/cre/service-quotas
- 架构公告：https://blog.chain.link/introducing-chainlink-runtime-environment/ 、https://chain.link/chainlink-runtime-environment
- 模板：https://docs.chain.link/cre-templates
