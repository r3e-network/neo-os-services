# Workflow Registry（开发者自助 Workflow 注册）

> P0-1 里程碑：对齐 Chainlink CRE 的 workflow 部署生命周期（create → activate → pause → delete），保持中心化服务形态。平台预置 workflow 仍在静态公共 catalog（`apps/web/public/morpheus-runtime-catalog.json`）中；开发者自有 workflow 存于 Supabase `morpheus_workflow_registry`（migration `0017_workflow_registry.sql`）。

## ID 命名空间

- 平台 workflow：`oracle.query`、`compute.execute`、`automation.upkeep` 等（静态 catalog，不可通过 API 修改）。
- 开发者 workflow：`user.<network>.<project-slug>.<name>`，由 API 自动生成，与平台命名空间物理隔离，且纳入 network 避免跨网络同名抢占。

## 鉴权

- 开发者端点使用 Supabase 用户 JWT：`Authorization: Bearer <supabase-user-jwt>`。
- 授权依据 project ownership：`morpheus_projects.owner_user_id = <user.id>`（与 RLS 策略一致）。
- 不存在或不属于自己的 project 统一返回 404，不泄露归属信息。
- 平台/运维通道（admin key）不受影响。

## API

### 创建 workflow

```bash
curl -X POST https://<web>/api/workflows \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <supabase-user-jwt>' \
  -d '{
    "project_slug": "acme",
    "name": "Price Watcher",
    "trigger_kind": "cron",
    "trigger_config": { "interval_seconds": 300 },
    "handler_source": "function run(input) { return input; }",
    "target_chain": "neo_n3"
  }'
```

- 新 workflow 初始状态为 `draft`，返回 201 + 公开记录（`id = user.mainnet.acme.price-watcher`）。
- 重名返回 409 `WORKFLOW_ALREADY_EXISTS`。

### 列出自己的 workflow

```bash
curl 'https://<web>/api/registry/workflows?project_slug=acme' \
  -H 'Authorization: Bearer <supabase-user-jwt>'
```

返回 `{ project_slug, network, workflows: [...] }`（不含 `deleted`）。公共平台 catalog 仍通过 `GET /api/workflows`（runtime token 保护，行为不变）。

### 更新 / 状态切换

```bash
curl -X PATCH https://<web>/api/workflows/user.mainnet.acme.price-watcher \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <supabase-user-jwt>' \
  -d '{ "status": "active" }'
```

可更新字段：`trigger_config`、`handler_source`、`status`。每次内容/状态变更自动 `version + 1`。

状态机：

```text
draft ──> active ──> paused ──> active
  │          │           │
  └──────────┴──> deleted（终态，软删除）
```

非法转换（如 `active -> draft`、`deleted -> *`）返回 400 `INVALID_STATUS_TRANSITION`。

### 删除（软删除）

```bash
curl -X DELETE https://<web>/api/workflows/user.mainnet.acme.price-watcher \
  -H 'Authorization: Bearer <supabase-user-jwt>'
```

行保留用于审计，列表自动排除。平台 workflow（非 `user.` 前缀）的 PATCH/DELETE 返回 403 `PLATFORM_WORKFLOW_IMMUTABLE`。

## Trigger 配置校验

| kind          | 要求                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `request`     | 无额外配置（链上请求触发）                                           |
| `cron`        | `cron`（5 字段）或 `interval_seconds >= 30`（对齐 CRE 的 cron 下限） |
| `http`        | `method` ∈ GET/POST，`path` 以 `/` 开头                              |
| `chain_event` | `event_name` 非空、<= 128 字符                                       |

## MVP 边界（当前未接线部分）

本里程碑交付 **注册表 + 生命周期 API**；以下执行侧接线属于后续里程碑，期间 `status` 只作为声明性状态：

- trigger 调度（cron/http/chain_event 的实际触发）尚未接入控制平面调度器；
- 用户 `handler_source` 尚未进入 TEE 执行 lane（现有执行仍走 `POST /oracle/smart-fetch`、`POST /compute/execute` 的内联 `script` 字段）；
- `version` 自增已在 API 层实现，但执行侧尚未消费（消费方通过 `version` 检测 drift）。

接入顺序建议（按依赖）：

1. 控制平面在 `automation_execute` / 新 trigger lane 读取 `status = 'active'` 的 registry 行；
2. TEE 执行 lane 复用现有 `node:vm` 沙箱（`workers/nitro-worker/src/platform/script-child.cjs`）执行 `handler_source`；
3. 执行记录写入 `morpheus_workflow_executions`（0011 已有表）。
