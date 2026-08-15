# neo-morpheus-oracle 项目审计与优化路线图

**审计日期：** 2026-07-04
**工作流：** GSD `map-codebase` 已产出 7 份代码库文档，本报告为基于这些文档的综
合审计与优化阶段规划。

---

## 1. 项目概览（TL;DR）

`neo-morpheus-oracle` 是一个面向 Neo N3 的机密预言机栈，采用多子系统 monorepo 架构：

- **Web 应用层**：`apps/web`（Next.js 15 + React 18），承载仪表盘、API 路由和文档
- **控制平面**：Cloudflare Workers（Edge Gateway + Control Plane）
- **机密执行层**：AWS Nitro Enclaves（`workers/nitro-worker`）
- **链上异步桥接层**：`workers/morpheus-relayer`（Neo N3 / Neo X）
- **链上合约**：Neo N3 C# 合约（`contracts/`）+ EVM Solidity 合约（`contracts-evm/`）
- **持久状态**：Supabase PostgreSQL（15 个迁移文件）
- **共享库**：`packages/shared`
- **部署/脚本**：`deploy/`、`scripts/`、`monitoring/`、`config/`

技术栈横跨 TypeScript/Node.js 22、C#/.NET 10、Solidity 0.8.24、Go 1.22（仅
Nitro EIF 构建）、SQL，测试栈覆盖 Vitest、Node.js 原生 `--test`、xUnit 和 Foundry。

---

## 2. 项目优势

| 领域                         | 优势                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| **架构**                     | 控制平面/持久层/执行层职责清晰，TEE 边界窄；网络选择通过路径前缀而非单独部 |
| 署                           |
| **可观测性**                 | Sentry、Better Stack、Checkly、Prometheus/Grafana、Cloudflare 可观测性     |
| 已接入，形成较完整的监控矩阵 |
| **CI/CD**                    | GitHub Actions 覆盖格式化、Lint、测试、合约构建、镜像发布、Vercel 部署     |
| **测试**                     | 多运行时测试栈齐全，已有大量测试文件和工厂模式                             |
| **文档**                     | 架构、部署、操作、安全、验证等文档较完整，且代码中有 FOOTGUN 注释          |
| **安全设计**                 | 客户端加密、TEE 内解密、Nitro 远程证明、子进程权限模型已具备基础框架       |

---

## 3. 关键风险与问题（按优先级排序）

### 🔴 P0 — 必须尽快处理

1. **安全漏洞：已知 npm audit 问题**
   - `@cityofzion/neon-core`（高，通过 `elliptic`/`lodash`）
   - `@sentry/nextjs`（中，OpenTelemetry）
   - `brace-expansion`（中，DoS）
   - `@babel/core`（低，任意文件读取）
   - 文件：`package-lock.json`、`apps/web/package.json`、`package.json`
   - 建议：升级或覆盖依赖，增加 CI audit 门禁

2. **公共 API 缺乏认证与输入校验**
   - `/api/workflows`、`/api/policies`、`/api/networks`、`/api/neodid/resolve` 无认证
   - 输入解析缺乏 Schema 校验（Zod 等）
   - 文件：`apps/web/app/api/workflows/route.ts` 等
   - 建议：为公共端点添加统一校验中间件和速率限制

3. **内存限流器存在绕过风险**
   - `apps/web/lib/rate-limit.ts` 在缺少 Upstash 时回退到进程内 Map
   - 多实例部署时实际预算 × 实例数，且清理是 O(n)
   - 建议：生产环境强制 Redis/Upstash，禁止进程内回退

4. **TEE 子进程权限配置可放宽**
   - `script-runner.js` 和 `wasm-runner.js` 的权限模型受环境变量控制
   - 建议：生产环境禁用非权限模式，并校验 `SCRIPT_CHILD_ALLOW_NET` 范围

### 🟡 P1 — 重要优化

5. **类型安全缺口**
   - `ServerSupabaseClient` 为 `any` 导出；多处 Supabase 查询使用 `as any`
   - Dashboard 组件中大量使用 `any`（OracleTab、ComputeTab、ProvidersTab）
   - 建议：生成或手写 Supabase 类型，为 Dashboard 引入共享类型

6. **Relayer 错误分类基于字符串/正则启发式**
   - `fulfillment.js` 的 `classifyError` 使用子串匹配决定重试/终结/死信
   - 新错误信息易被误分类，导致无限重试或提前终结
   - 建议：从 worker/合约客户端返回结构化错误码，字符串分类仅作兜底

7. **核心工作模块过大**
   - `fulfillment.js` (~1968 行)、`neo-n3.js` (~1280 行)、`feeds.js` (~990 行)、
     `automation.js` (~867 行)
   - 建议：按职责拆分为小模块，如 `feed-submit.js` 模式

8. **缺少统一结构化日志**
   - 混合使用 `console`、Sentry、Better Stack，无统一日志 schema
   - 建议：定义共享 logger 接口并在 web/worker/script 中统一采用

9. **Cron 诊断信息泄露**
   - `apps/web/app/api/cron/feed/route.ts` 返回环境变量名和 header 长度
   - 建议：生产环境返回通用 `unauthorized`，细节仅服务端日志

10. **Nitro 密钥库读取错误被静默吞掉**
    - `workers/nitro-worker/src/oracle/crypto.js:228-238` 对异常使用空 `catch {}`
    - 建议：区分 ENOENT 与 JSON 解析错误，后者应抛出

### 🟢 P2 — 建议改进

11. **Dashboard 串行链上读取**
    - 多个组件独立发起 RPC 调用
    - 建议：增加服务端聚合端点并缓存

12. **Supabase 查找缓存为进程本地**
    - 默认 30 秒 TTL，但多实例时命中率低
    - 建议：迁移到 Redis/Upstash

13. **Neo N3 RPC URL 提升存在竞态**
    - `promoteNeoN3RpcUrl` 直接修改共享配置对象
    - 建议：请求开始时快照 URL 列表，避免并发修改

14. **链游标检查点静默重置**
    - `chain-cursor.js` 遇到无效检查点时回到起始块
    - 建议：增加告警和人工确认

15. **测试覆盖缺口**
    - Dashboard 组件、`CodeBlock` XSS 安全、Relayer 错误分类、子进程沙箱权限
    - 建议：补充测试用例

16. **Solidity 编译器版本较旧**
    - 固定 `solc 0.8.24`，可评估升级至最新 0.8.x

---

## 4. 优化阶段规划

基于 GSD 阶段规划方法，建议按以下 4 个阶段推进。每个阶段结束时进行验证
（`verify-work`），通过后再进入下一阶段。

### Phase 1 — 安全与依赖加固（P0 安全）

**目标**：消除已知安全漏洞，降低公共 API 和 TEE 执行面的攻击风险。

**关键任务**：

- 运行 `npm audit` 并修复依赖（重点 `neon-core`、`@sentry/nextjs`）
- 在 CI 中增加 `npm audit --audit-level=moderate` 门禁
- 为公共 API 路由添加统一认证/速率限制中间件
- 生产环境强制禁用内存限流回退，强制使用 Upstash/Redis
- 生产环境强制启用 TEE 子进程权限模型，并校验网络白名单
- 减少 Cron 诊断输出，避免信息泄露

**验证**：

- `npm audit` 0 高危/中危
- 公共端点返回 401/429 测试通过
- 生产构建环境变量正确，无内存限流回退

### Phase 2 — 类型安全与核心模块重构（P1 工程债）

**目标**：提升关键路径的类型安全，降低大模块的认知负荷和回归风险。

**关键任务**：

- 为 `apps/web/lib/server-supabase.ts` 引入生成/手写的 Supabase 类型，替换 `any`
- 在 `packages/shared` 或 `apps/web/lib/types` 定义 `OracleState`、`OracleKeyMeta`、
  `ProviderConfig`，并应用到 Dashboard 组件
- 将 `workers/morpheus-relayer/src/fulfillment.js` 按职责拆分为多个模块
- 将 `workers/morpheus-relayer/src/neo-n3.js` 拆分为扫描、提交、URL 管理模块
- 将 `workers/nitro-worker/src/oracle/feeds.js` 进一步拆分

**验证**：

- `apps/web` TypeScript 检查无 `any` 逃逸
- 相关单元测试全部通过
- 模块拆分后功能等价（通过现有测试 + 回归测试）

### Phase 3 — 错误处理与可观测性升级（P1 可靠性）

**目标**：用结构化错误码和统一日志替换字符串启发式与 console 日志，提升可观测性。

**关键任务**：

- 在 `packages/shared` 定义错误码 schema，worker 返回结构化错误
- 将 `classifyError` 改造为错误码优先、字符串兜底
- 设计并落地统一结构化 logger（Better Stack 兼容）
- 替换关键路径的 `console.log`/`console.error` 为结构化 logger
- 修复 `crypto.js` 空 `catch`，区分 ENOENT 与 JSON 错误

**验证**：

- 错误分类测试覆盖新增错误码和旧字符串
- 关键路径日志输出 JSON schema 符合预期
- `crypto.js` 对错误密钥文件正确抛出

### Phase 4 — 性能与扩展性优化（P2 扩展性）

**目标**：提升水平扩展能力、减少链上读取延迟、降低 Supabase 压力。

**关键任务**：

- 迁移 Supabase 查找缓存和限流状态到共享 Redis/Upstash
- 为 Dashboard 增加服务端聚合端点（`/api/onchain/state` 扩展）
- 修复 `promoteNeoN3RpcUrl` 竞态
- 为链游标检查点重置增加告警和人工确认
- 评估升级 `solc` 到最新 0.8.x

**验证**：

- 聚合端点响应时间 < 200ms（带缓存）
- 并发测试下 RPC URL 列表无异常变更
- 合约测试在升级后通过

---

## 5. 下一步建议

1. **用户确认优先级**：以上 P0/P1/P2 是否与我方判断一致？是否需要调整阶段顺序？
2. **进入 Phase 1**：如果同意，我可以立即启动 Phase 1 的详细计划与执行（依赖修复、安全加固）。
3. **保留代码库地图**：`.planning/codebase/` 中的 7 份文档将作为后续优化阶段的上下文依据，
   建议随代码变更同步更新。

---

_审计报告基于 GSD 代码库映射产出，下一步将进入 GSD `plan-phase` / `execute-phase` 循环。_
