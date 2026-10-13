# Environment Guide / 环境变量指南

This guide explains the environment variables used by `neo-os-services` in plain English and Chinese.
If you are not a developer, you do **not** need to memorize everything.
Think of the variables in four layers:

本指南用中英文解释 `neo-os-services` 使用的环境变量。
如果你不是开发者，你**不需要**记住所有变量。
你只需要把变量理解成四层：

1. Chain addresses and RPCs / 链地址与 RPC
2. Signing keys / 签名密钥
3. Nitro and Supabase access / Nitro 与 Supabase 访问
4. Runtime policy knobs / 运行策略参数

## Local network configuration gate

Before deployment, run `npm run check:network-config` with `MORPHEUS_NETWORK`
(or the fallback `NEXT_PUBLIC_MORPHEUS_NETWORK`) set to `mainnet` or `testnet`.
The runtime variable takes precedence; surrounding whitespace and case are normalized.
This local gate checks environment labels only: it does not load credentials, contact
RPC endpoints, verify chain identity, or change configuration files.

- Valid configuration exits **0**, including with `--fail-on-missing`. That flag is
  retained for compatibility; missing configuration already fails without it.
- Missing or invalid configuration, invalid arguments, and expected-network
  mismatches exit **1** with a diagnostic.
- Both `--expected mainnet` and `--expected=mainnet` enforce the same check.
  An empty, missing, or unsupported expected network fails rather than disabling it.
- Optional deployment-setting warnings do not change the exit status.

Examples (run from the services repository; no network access):

```sh
MORPHEUS_NETWORK=mainnet npm run check:network-config
# VALIDATION PASSED; exit 0
MORPHEUS_NETWORK=testnet node scripts/check-network-config.mjs --expected mainnet
# Network mismatch; exit 1
MORPHEUS_NETWORK=testnet node scripts/check-network-config.mjs --expected=testnet
# VALIDATION PASSED; exit 0
```

The regression suite runs bounded subprocesses against the real CLI, using network
names from the checked-in registries and isolated environments. It is included by
`npm run test:scripts` (`scripts/*.test.mjs`). No deployment or data migration is
required; existing callers using `--fail-on-missing` now receive the correct success
status instead of an unconditional failure.

## Must Know / 你必须关心的变量

These are the variables that matter for day-to-day operation.
If one of these is wrong, the system usually stops working.

这些是日常运行最关键的变量。
其中任意一个出错，系统通常就会停止工作。

### Runtime Access / Runtime 访问

- `MORPHEUS_RUNTIME_URL`
  English: Explicit URL of the confidential Morpheus runtime. In production, confidential/mutating calls try this endpoint only; the web tier and relayer do not append or traverse the `oracle.meshmini.app` / `edge.meshmini.app` public fallbacks.
  中文：机密 Morpheus runtime 的显式地址。生产环境中的机密/变更类调用只尝试此端点；web 与 relayer 不会追加或遍历 `oracle.meshmini.app` / `edge.meshmini.app` 公网回退。

- `MORPHEUS_MAINNET_RUNTIME_URL` / `MORPHEUS_TESTNET_RUNTIME_URL`
  English: Optional network-scoped runtime URLs when you want explicit mainnet/testnet separation.
  中文：可选的分网络 runtime 地址，用于显式区分 mainnet/testnet。

- `NEXT_PUBLIC_MORPHEUS_RUNTIME_URL`
  English: Browser/public runtime URL used only by explicitly non-confidential status and catalog operations. In production it is never promoted into the server's confidential Nitro candidate list and never receives the server's runtime bearer on fallback.
  中文：仅供显式标记为非机密的状态与目录操作使用的浏览器/公网 runtime 地址。生产环境绝不会将其提升为服务端机密 Nitro 候选地址，回退请求也绝不会携带服务端 runtime bearer。

- `MORPHEUS_BOX_HEALTH_URL_MAINNET` / `MORPHEUS_BOX_HEALTH_URL_TESTNET`
  English: Network-scoped health endpoints for the attested box used by `apps/web` runtime status. Configure both in production; a URL may contain the `{network}` placeholder. A generic `MORPHEUS_BOX_HEALTH_URL` is only a fallback and a reported network mismatch is fail-closed.
  中文：`apps/web` runtime status 使用的 attested box 分网络健康地址。生产环境应同时配置两项；地址可包含 `{network}` 占位符。通用的 `MORPHEUS_BOX_HEALTH_URL` 仅作 fallback，若返回的 network 不匹配会 fail-closed。

- `MORPHEUS_RUNTIME_TOKEN`
- `NITRO_API_TOKEN` or `NITRO_SHARED_SECRET`
  English: Data-plane authentication secret for the Nitro runtime. Prefer `MORPHEUS_RUNTIME_TOKEN`. It does not authorize control-plane workflow, broadcast, feed-tick, automation, or relayer-operations routes. In production the web proxy attaches it only to exact server-configured `MORPHEUS_RUNTIME_URL` candidates, never public/registry fallbacks.
  中文：Nitro runtime 数据面的鉴权密钥。优先使用 `MORPHEUS_RUNTIME_TOKEN`。它不授权控制面 workflow、广播、feed-tick、自动化或 relayer 运维接口。生产环境的 web 代理只会把它发往服务端显式配置的 `MORPHEUS_RUNTIME_URL` 候选地址，绝不会发给公网/注册表回退地址。

### Edge Hardening / 边缘防护

- `UPSTASH_REDIS_REST_URL`
  English: Upstash Redis REST endpoint used by worker-side rate limiting and idempotency guards. **Required in production** for the `apps/web` rate limiter; the application will refuse to start if it is missing in production.
  中文：worker 侧限流与幂等保护使用的 Upstash Redis REST 地址。在生产环境中 **必须** 配置 `apps/web` 的限流器；若缺失，应用将拒绝启动。

- `UPSTASH_REDIS_REST_TOKEN`
  English: Upstash Redis REST bearer token. **Required in production** alongside `UPSTASH_REDIS_REST_URL`.
  中文：Upstash Redis REST 鉴权 token。生产环境中需与 `UPSTASH_REDIS_REST_URL` 一起配置。

- `MORPHEUS_UPSTASH_GUARDS_ENABLED`
  English: Enables worker-side Upstash-backed request guards for sensitive routes like paymaster / relay / compute / VRF.
  中文：开启 worker 侧基于 Upstash 的敏感路由保护，例如 paymaster / relay / compute / VRF。

- `MORPHEUS_UPSTASH_FAIL_CLOSED`
  English: If `true`, Upstash failures reject guarded requests instead of failing open.
  中文：若为 `true`，Upstash 故障时拒绝请求，而不是放行。

- `MORPHEUS_RATE_LIMIT_PAYMASTER_AUTHORIZE_MAX`
- `MORPHEUS_RATE_LIMIT_RELAY_TRANSACTION_MAX`
- `MORPHEUS_RATE_LIMIT_COMPUTE_EXECUTE_MAX`
- `MORPHEUS_RATE_LIMIT_VRF_RANDOM_MAX`
- `MORPHEUS_RATE_LIMIT_ORACLE_QUERY_MAX`
  English: Per-route fixed-window request ceilings enforced through Upstash.
  中文：通过 Upstash 执行的分路由固定窗口请求上限。

- `CLOUDFLARE_API_TOKEN`
  English: Optional deployment/admin token for Cloudflare scripts and worker rollout.
  中文：可选的 Cloudflare 部署/管理 token，用于脚本和 worker 发布。

- `CLOUDFLARE_ACCOUNT_ID`
  English: Cloudflare account id used when deploying the edge gateway worker.
  中文：发布 edge gateway worker 时使用的 Cloudflare account id。

- `TURNSTILE_SECRET_KEY`
  English: Optional secret used by the Cloudflare gateway worker to verify Turnstile tokens on abuse-prone endpoints.
  中文：Cloudflare gateway worker 可选使用的 Turnstile secret，用于高风险接口的人机验证。

### Supabase / Supabase

- `SUPABASE_URL`
  English: Supabase project URL for server-side reads/writes.
  中文：Supabase 项目地址，后端和 relayer 写数据时会用到。

- `SUPABASE_SECRET_KEY` preferred, or legacy `SUPABASE_SERVICE_ROLE_KEY`
  English: High-privilege Supabase server key for server routes and relayer persistence. Prefer the modern `sb_secret_...` secret key when both are present.
  中文：Supabase 高权限服务端 key，后端接口和 relayer 写运行记录时会用到。若同时存在，优先使用新版 `sb_secret_...` secret key。

  English: It is also used for web operation logging and encrypted-ciphertext persistence.
  中文：它也用于 web 操作日志写入和加密密文持久化。

### Admin Control Plane / 管理面权限

- `MORPHEUS_PROVIDER_CONFIG_API_KEY`
  English: Admin key for provider-config management routes ONLY. It does not authorize control-plane execution (callback broadcast, feed-tick, automation, job reads) or Cloudflare control-plane ingress — use an operator/control-plane key for those.
  中文：仅用于 provider 配置管理接口的管理员 key。它**不**授权控制面执行（回调广播、feed-tick、自动化、任务读取）或 Cloudflare 控制面入口——这些请使用 operator / 控制面 key。

- `CONTROL_PLANE_API_KEY`
  English: Primary control-plane credential. In production it must be configured independently from all Nitro runtime data-plane tokens.
  中文：主控制面凭据。生产环境中必须单独配置，不能与任何 Nitro runtime 数据面 token 共用。

- `MORPHEUS_WORKFLOW_API_KEY`
  English: Credential for workflow callbacks, feed ticks, and automation execution. The Cloudflare control plane should use this when calling the application backend.
  中文：workflow 回调、feed tick 与自动化执行凭据。Cloudflare 控制面调用应用后端时应使用它。

- `MORPHEUS_RELAYER_API_KEY`
  English: Independent credential for relayer-originated control-plane calls.
  中文：relayer 发起控制面调用时使用的独立凭据。

- `MORPHEUS_RELAYER_ADMIN_API_KEY`
  English: Admin key for relayer metrics, jobs, retry, and replay routes.
  中文：relayer 监控、任务、重试、重放接口使用的管理员 key。

- `MORPHEUS_SIGNING_ADMIN_API_KEY`
  English: Admin key for the signing admin scope. The `/api/sign/payload` web proxy was retired (CU-149): the measured image refuses blind payload signing with 503 unless it sets `ENCLAVE_ALLOW_BLIND_SIGN=1`, which the shipped posture does not, so the public endpoint advertised a lane that could not answer. The key is still a required, pairwise-distinct credential.
  中文：签名管理员 scope 使用的管理员 key。`/api/sign/payload` Web 代理已下线（CU-149）：测量镜像在未设置 `ENCLAVE_ALLOW_BLIND_SIGN=1` 时以 503 拒绝盲签，而发布姿态并不设置它，因此该公开端点指向一个无法应答的通道。该 key 仍是必需且两两不同的凭据。

- `MORPHEUS_RELAY_ADMIN_API_KEY`
  English: Admin key for the relay admin scope. The `/api/relay/transaction` web proxy was retired (CU-149): the host has no `/relay/transaction`, and transaction submission goes through the relayer, not the enclave. The key is still a required, pairwise-distinct credential.
  中文：relay 管理员 scope 使用的管理员 key。`/api/relay/transaction` Web 代理已下线（CU-149）：host 并无 `/relay/transaction`，交易提交走 relayer 而非 enclave。该 key 仍是必需且两两不同的凭据。

- `MORPHEUS_OPERATOR_API_KEY`
  English: Operator/control-plane credential. Production does not reuse it as
  a fallback for relayer, signing, or relay routes: every privilege domain must
  have a pairwise-distinct value.
  中文：运维/控制面凭据。生产环境不会再将其复用为 relayer、签名或 relay
  路由的回退凭据；每个权限域都必须使用两两不同的值。

- `MORPHEUS_CONTROL_PLANE_LEGACY_RUNTIME_TOKEN_COMPAT`
- `MORPHEUS_ALLOW_LEGACY_RUNTIME_CONTROL_PLANE` (migration alias)
  English: Development-only migration switch allowing a runtime token on control-plane scopes. Production ignores it and fails closed. Independently named credentials that reuse a runtime token value are also rejected.
  中文：仅开发环境使用的迁移开关，临时允许 runtime token 用于控制面作用域。生产环境忽略此开关并 fail-closed；独立命名但复用 runtime token 值的凭据同样会被拒绝。

- `ADMIN_CONSOLE_API_KEY`
  English: Legacy fallback admin key. Prefer scoped keys above in production.
  中文：旧的通用管理员 key。生产环境更建议使用上面这些分域 key。

### Neo N3 / Neo N3

- `NEO_RPC_URL`
  English: Neo N3 RPC endpoint.
  中文：Neo N3 的 RPC 地址。

- `NEO_NETWORK_MAGIC`
  English: Neo N3 network magic. Must match testnet or mainnet.
  中文：Neo N3 网络 magic，必须和当前网络一致。

- `CONTRACT_MORPHEUS_ORACLE_HASH`
  English: Neo N3 MorpheusOracle contract hash.
  中文：Neo N3 的 MorpheusOracle 合约地址。

- `CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH`
  English: Optional Neo N3 external callback adapter contract hash. The kernel inbox is canonical; this is only needed for integrations that still want a dedicated callback bridge.
  中文：可选的 Neo N3 外部 callback adapter 合约地址。系统 inbox 才是标准路径；只有仍然需要独立 callback bridge 的集成才需要它。

- `CONTRACT_MORPHEUS_DATAFEED_HASH`
  English: Neo N3 shared numeric resource module contract hash.
  中文：Neo N3 共享数值资源模块合约地址。

- `MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY` or `MORPHEUS_WORKER_NEO_N3_WIF`
  English: Legacy worker-side Neo N3 signing material. No worker lane reads it any more — worker signing goes through the custody signer service (`SIGNER_ROLE_WORKER_KEY_ID`).
  中文：遗留的 worker Neo N3 签名私钥。worker 各通道均已不再读取——worker 签名一律走托管签名服务（`SIGNER_ROLE_WORKER_KEY_ID`）。

- `MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY` or `MORPHEUS_ORACLE_VERIFIER_WIF`
  English: Legacy verifier signing material. No lane reads it any more — on-chain result verification uses the public key only (`MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY`), and the name survives only in the pinned-registry drift checks.
  中文：遗留的 verifier 签名私钥。任何通道均已不再读取——链上结果校验只使用公钥（`MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY`）；该变量名仅存在于 pinned 注册表 drift 校验。

- `NEO_N3_WIF`
  English: Generic Neo N3 operator WIF consumed only by local smoke tooling (`scripts/smoke-oracle-n3.mjs`, `run-testnet-rng-local.sh`). No deployed runtime lane reads it — all signing is custody-side.
  中文：通用 Neo N3 WIF，仅本地冒烟工具（`scripts/smoke-oracle-n3.mjs`、`run-testnet-rng-local.sh`）消费。部署的运行时通道均不读取——签名全部走托管服务。

- `MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY` or `MORPHEUS_RELAYER_NEO_N3_WIF`
  English: Legacy relayer/updater Neo N3 signing material. No runtime lane reads it any more: relayer signing is custody-only and the web control plane relays through the worker's txproxy lane, leaving only smoke tooling and the pinned-registry drift checks.
  中文：旧版 relayer / updater 的 Neo N3 签名私钥。运行时通道均已不再读取：relayer 签名只走托管服务，web 控制面经 worker 的 txproxy 通道转发，仅剩冒烟工具与 pinned 注册表 drift 校验消费。

  English: There is no local or derived key fallback on any signing lane, including NeoDID digest signatures — provisioning `SIGNER_ROLE_WORKER_KEY_ID` is mandatory.
  中文：任何签名通道（包括 NeoDID 摘要签名）都不存在本地或派生密钥回退——必须配置 `SIGNER_ROLE_WORKER_KEY_ID`。

  English: The generated testnet Nitro env now disables derived signing by default when it injects an explicit verifier signer, so the published testnet verifier key is not accidentally shadowed by a derived role key.
  中文：现在生成的 testnet Nitro env 在注入显式 verifier signer 时会默认关闭派生签名覆盖，避免已发布到链上的 testnet verifier key 被派生角色密钥意外替换。

### Neo X signer boundary / Neo X 签名边界

- `MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN=true` and `NEOX_FEED_FROM`
  English: Legacy Node feed-pusher selection. The production Rust host now implements attested NeoX `/feed/sign` through the distinct `SIGNER_ROLE_NEOX_UPDATER_KEY_ID`, and the Rust relayer owns broadcast, successful receipt confirmation, and durable state. Production refuses the host-key route; these variables remain compatibility-only.
  中文：旧 Node feed-pusher 的选择项。生产 Rust host 已通过独立的 `SIGNER_ROLE_NEOX_UPDATER_KEY_ID` 实现可证明的 NeoX `/feed/sign`，并由 Rust relayer 负责广播、成功回执确认与持久化状态。生产环境拒绝 host-key 路径；这些变量仅保留用于兼容。

- `MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER=true`
  English: Development-only opt-in for legacy host-side Neo X signing. It never enables host signing in production.
  中文：仅开发环境使用的旧版 host-side Neo X 签名开关。它绝不会在生产环境启用 host 签名。

- `NEOX_FEED_PK`, `NEOX_UPDATER_PK`, `NEOX_VERIFIER_PK`
  English: Legacy host private keys. Vercel, control-plane, relayer, and production feed-pusher environments must not define them. The standalone host fulfiller is also production-disabled until a custody/enclave secp256k1 signer is wired.
  中文：旧版 host 私钥。Vercel、控制面、relayer 与生产 feed-pusher 环境不得定义这些变量。在 custody/enclave secp256k1 signer 接通前，独立 host fulfiller 在生产环境同样禁用。

### Provider Data Source / 数据源

- `TWELVEDATA_API_KEY`
  English: API key for the default market-data provider.
  中文：默认行情数据源 TwelveData 的 API key。

### NeoDID Web3Auth / NeoDID 的 Web3Auth 配置

- `WEB3AUTH_CLIENT_ID`
  English: Server-side Web3Auth client id used by the TEE worker when verifying `id_token` for `provider = "web3auth"`.
  中文：当 `provider = "web3auth"` 时，TEE worker 用来校验 `id_token` 的服务端 Web3Auth client id。

- `WEB3AUTH_CLIENT_SECRET`
  English: Server-only Web3Auth app key used to sign `originData` for frontend domain validation. This must never be exposed as a `NEXT_PUBLIC_*` variable.
  中文：仅服务端使用的 Web3Auth app key，用来为前端域名生成 `originData` 签名。它绝不能暴露成 `NEXT_PUBLIC_*` 变量。

- `NEXT_PUBLIC_WEB3AUTH_CLIENT_ID`
  English: Browser-exposed Web3Auth client id for the Next.js app. The worker also accepts it as a fallback if `WEB3AUTH_CLIENT_ID` is not set.
  中文：Next.js 前端可见的 Web3Auth client id。如果没有设置 `WEB3AUTH_CLIENT_ID`，worker 也会把它作为回退值使用。

- `NEXT_PUBLIC_WEB3AUTH_NETWORK`
  English: Browser-side Web3Auth network selection for the live login page. Current production default is `sapphire_mainnet`.
  中文：前端 Web3Auth 登录页使用的网络选择。当前生产默认值是 `sapphire_mainnet`。

- `WEB3AUTH_JWKS_URL`
  English: JWKS endpoint used by the TEE worker to verify Web3Auth JWT signatures. Default is `https://api-auth.web3auth.io/.well-known/jwks.json`.
  中文：TEE worker 用于校验 Web3Auth JWT 签名的 JWKS 地址。默认值是 `https://api-auth.web3auth.io/.well-known/jwks.json`。

## Common Tuning / 常用调节项

These variables are safe to change when tuning behavior.
They do not usually change trust assumptions.

这些变量常用于调节行为。
它们通常不会改变系统的信任模型。

### Feed Policy / Feed 策略

- `MORPHEUS_ACTIVE_CHAINS`
  English: Comma-separated active chain list for relayer scanning and feed sync: `neo_n3`, `neox`, or both. The generated production template defaults conservatively to `neo_n3`; both chains are authoritative when fully configured.
  中文：relayer 扫链和 feed 同步使用的活动链列表，可为 `neo_n3`、`neox` 或两者。生成的生产模板保守地默认 `neo_n3`；完整配置后两条链均为权威 Rust 通道。

- `MORPHEUS_FEED_PROJECT_SLUG`
  English: Default project slug used by feed tasks.
  中文：feed 任务默认使用的项目 slug。

- `MORPHEUS_FEED_PROVIDER`
  English: Default provider for feed sync tasks.
  中文：feed 同步任务默认 provider。

- `MORPHEUS_FEED_PROVIDERS`
  English: Comma-separated provider list for multi-provider feed reads.
  中文：多 provider feed 读取时使用的 provider 列表，逗号分隔。

- `MORPHEUS_FEED_SYMBOLS`
  English: Comma-separated default pair list.
  中文：默认交易对列表，逗号分隔。
  English: This now covers crypto, equities, ETFs, commodities, and FX pairs. Pair-level scaling can still be applied through the feed registry.
  中文：现在默认列表可覆盖加密资产、股票、ETF、大宗商品和外汇；如有超小价格对，仍可通过 feed registry 做单位缩放。

- `MORPHEUS_FEED_CHANGE_THRESHOLD_BPS`
  English: Minimum price change before a new on-chain feed update is submitted.
  中文：价格变化至少达到多少 basis points 才提交新的链上 feed 更新。

- `MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS`
  English: Minimum time between feed submissions. Current production default is `60000` so the mainnet scanner evaluates the full catalog once per minute.
  中文：两次 feed 提交之间的最短间隔。当前生产默认值是 `60000`，也就是主网每分钟扫描一次完整价格目录。

- `MORPHEUS_FEED_SYNC_INTERVAL_MS`
  English: Feed-sync scan cadence for the relayer loop.
  中文：relayer 扫描并触发 feed 同步的周期。

### Relayer / Relayer

- `MORPHEUS_RELAYER_POLL_INTERVAL_MS`
  English: How often the relayer scans for new chain events.
  中文：relayer 轮询链上新事件的频率。

- `MORPHEUS_RELAYER_CONCURRENCY`
  English: Maximum number of parallel fulfill jobs.
  中文：relayer 并发处理 fulfill 的最大数量。

- `MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK`
  English: Maximum block span scanned per relayer loop.
  中文：每次 relayer 循环最多扫描多少个区块。

- `MORPHEUS_RELAYER_MAX_RETRIES`
  English: Maximum retry count for failed jobs.
  中文：失败任务最多重试次数。

- `MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS`
  English: Base retry delay.
  中文：重试的基础延迟。

- `MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS`
  English: Maximum retry delay.
  中文：重试的最大延迟。

- `MORPHEUS_RELAYER_NEO_N3_START_BLOCK`
  English: Optional Neo N3 start block used when the relayer has no saved checkpoint yet.
  中文：当 relayer 还没有保存过 checkpoint 时，Neo N3 扫块使用的可选起始区块。

### Automation / 自动化任务

- `MORPHEUS_AUTOMATION_ENABLED`
  English: Legacy automation scheduler switch. The production Rust relayer currently requires `false` and rejects `true` during `config:validate` and `ensure_runtime_ready` because durable automation claim/confirmation/persistence is not yet authoritative. `NODE_ENV=production` cannot override this refusal.
  中文：旧自动化调度器开关。当前生产 Rust relayer 必须设为 `false`；由于自动化的持久 claim/确认/落盘协议尚未成为权威实现，`config:validate` 与启动 `ensure_runtime_ready` 都会拒绝 `true`。`NODE_ENV=production` 不能覆盖该拒绝。

- `MORPHEUS_ALLOW_UNAVAILABLE_AUTOMATION`
  English: Non-production opt-in only. When `true` and `NODE_ENV` is not `production`, `config:validate` / startup may proceed with a warning while the automation lane still reports `rust_automation_execution_not_implemented`. Production ignores this flag and still refuses `MORPHEUS_AUTOMATION_ENABLED=true`.
  中文：仅非生产显式允许。设为 `true` 且 `NODE_ENV` 不是 `production` 时，校验/启动可以带着警告继续，但 automation 车道仍报告未实现。生产环境忽略此开关，仍然拒绝 `MORPHEUS_AUTOMATION_ENABLED=true`。

- `MORPHEUS_AUTOMATION_BATCH_SIZE`
  English: Maximum active automation jobs loaded from Supabase per tick.
  中文：每个 tick 从 Supabase 读取的活跃自动化任务上限。

- `MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK`
  English: Maximum number of due automation executions that may be queued on-chain per tick.
  中文：每个 tick 最多排队上链的自动化执行次数。

- `MORPHEUS_AUTOMATION_PRICE_PAIRS_PER_TICK`
  English: Reserved knob for limiting per-tick price-trigger evaluation fan-out.
  中文：限制每个 tick 价格触发检查扇出的预留参数。
  English: Keep this at or above the configured pair catalog size if you expect all pairs to be evaluated within the same scheduler cycle.
  中文：如果你希望同一个调度周期内检查完全部价格对，这个值应不小于当前配置的 pair 总数。

- `MORPHEUS_AUTOMATION_DEFAULT_PRICE_COOLDOWN_MS`
  English: Default cooldown for price-threshold triggers when the job does not specify one.
  中文：价格阈值触发器未显式指定冷却期时使用的默认冷却时间。

### Timeouts / 超时

- `ORACLE_TIMEOUT`
  English: Upstream fetch timeout for Oracle requests.
  中文：Oracle 拉取外部数据时的超时。

- `ORACLE_MAX_PROVIDER_BODY_BYTES`
  English: Maximum response size for built-in provider fetches such as TwelveData / Coinbase / Binance. Use this when provider-side HTML or verbose JSON errors exceed the stricter generic upstream cap.
  中文：内建 provider（例如 TwelveData / Coinbase / Binance）响应体的最大字节数。当 provider 侧返回较大的 HTML 或详细 JSON 错误时，可用它覆盖更严格的通用上限。

- `ORACLE_SCRIPT_TIMEOUT_MS`
  English: Timeout for JS oracle scripts.
  中文：旧 JS Oracle 脚本的超时。

- `COMPUTE_SCRIPT_TIMEOUT_MS`
  English: Timeout for JS compute scripts.
  中文：旧 JS Compute 脚本的超时。

- `MORPHEUS_WASM_TIMEOUT_MS`
  English: Global default timeout for WASM execution. Current default is `30000`.
  中文：WASM 执行的全局默认超时。当前默认值是 `30000`。

- `ORACLE_WASM_TIMEOUT_MS`
  English: Oracle-only WASM timeout override.
  中文：只覆盖 Oracle WASM 执行超时。

- `COMPUTE_WASM_TIMEOUT_MS`
  English: Compute-only WASM timeout override.
  中文：只覆盖 Compute WASM 执行超时。

## Advanced / 高级配置

Only touch these if you understand the runtime model.

这些变量只建议在理解运行时模型后再修改。

### Derived Keys / 派生密钥

- `NITRO_USE_DERIVED_KEYS`
  English: Enables derived keys (from AWS Secrets Manager) for worker and relayer signing.
  中文：开启派生密钥（来自 AWS Secrets Manager），供 worker 和 relayer 用于签名。

### Attestation / 远程认证

- `NITRO_EMIT_ATTESTATION`
  English: Adds Nitro (NSM) attestation metadata to worker responses when requested.
  中文：在请求需要时，把 Nitro (NSM) attestation 元数据附加到 worker 返回里。

### Oracle Key Storage / Oracle 密钥封装存储

- `NITRO_ORACLE_ENCRYPTION_KEY_PATH`
  English: Wrapping-key path for the stable Oracle X25519 transport key.
  中文：稳定 Oracle X25519 传输密钥所使用的封装密钥路径。

- `NITRO_ORACLE_KEYSTORE_PATH`
  English: Filesystem path where the sealed Oracle transport key is stored.
  中文：封装后的 Oracle 传输密钥在文件系统中的存放路径。

## Deliberately Disabled By Default / 默认故意关闭的高风险项

These are intentionally left unset in production unless you explicitly want the risk.

这些变量默认不建议开启，除非你明确知道风险并接受它。

- `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS`
  English: Enables user-supplied JS script execution. Default unset means disabled.
  中文：允许执行用户提供的 JS 脚本。默认不写就是关闭。

- `MORPHEUS_ALLOW_UNSAFE_PROVIDER_BASE_URL_OVERRIDE`
  English: Allows provider requests to override builtin base URLs. Default unset means disabled.
  中文：允许 provider 请求覆盖内置 base URL。默认不写就是关闭。

- `MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE`
  English: Tests only. Names the 20-byte oracle contract script hash the measured Rust host binds a Neo N3 fulfilment digest to, so a kernel deployed fresh on a private chain can be fulfilled. Default unset means the compiled-in measured contract binds, unchanged. Refused with 503 when `NODE_ENV=production`, when the network is `mainnet`, or when the value is not a 20-byte hex script hash. Image ENV only: not in the `/provision` allowlist, so it cannot be set at runtime. The supplied contract must still equal it and the network magic still comes from the reviewed identity registry, so a request never chooses this value. See `workers/neo-os-relayer/LOCAL-CHAIN.md`.
  中文：仅供测试。指定实测 Rust 主机绑定 Neo N3 履约摘要所用的 20 字节 oracle 合约脚本哈希，使私有链上新部署的 kernel 可以被履约。默认不写即使用编译进镜像的实测合约，行为不变。当 `NODE_ENV=production`、网络为 `mainnet`，或该值不是 20 字节十六进制脚本哈希时，一律以 503 拒绝。仅支持镜像 ENV：不在 `/provision` 白名单内，运行时无法设置。请求携带的合约仍必须与其相等，网络 magic 仍取自已审阅的身份注册表，请求本身无法决定该值。参见 `workers/neo-os-relayer/LOCAL-CHAIN.md`。

- `MORPHEUS_FEED_BALANCE_GAS`
  English: The updater's GAS balance, supplied by an operator for the enclave host's `/health` runway report. The host holds no key and has no chain RPC for it, so this is the only source. Default unset means the runway reports `runway_basis: balance_unknown` with a null `runway_days` — unknown, never a healthy-looking number.
  中文：由运维提供的 updater GAS 余额，供 enclave 主机 `/health` 的 runway 报告使用。主机不持有密钥也没有对应的链上 RPC，因此这是唯一来源。默认不写时 runway 报告 `runway_basis: balance_unknown` 且 `runway_days` 为 null——是未知，而不是看似健康的数值。

- `MORPHEUS_FEED_WRITE_FEE_GAS`
  English: The GAS fee of one feed write, used for the "cannot pay one write" rule. Default unset means the observed two-pair write fee `0.00606339`. The host observes signed plans, not confirmed writes, so this input never converts signed plans into actual burn or runway.
  中文：一次 feed 写入的 GAS 费用，用于“付不起一次写入”的判定。默认不写时使用实测的双 pair 写入费用 `0.00606339`。主机仅观察签名计划，未观察确认写入，因此不会据此将签名次数折算为实际消耗或 runway。

- `MORPHEUS_FEED_MAX_WRITES_PER_DAY`
  English: The daily write cap reported on `/health` as `writes.budget`. It is reported, not enforced. Since the host has no broadcast or confirmation receipts, `writes.observed` is null and a configured cap's `budget_state` is unknown. An unset cap reports unbounded. N3 signed plans appear separately in `signed_plans` and never prove cap usage.
  中文：在 `/health` 的 `writes.budget` 中报告的每日写入上限，只报告、不强制。主机未接收广播或确认回执，因此 `writes.observed` 为 null，已配置上限的 `budget_state` 为 unknown。未配置上限时报告 unbounded。N3 签名计划单独列入 `signed_plans`，不代表实际额度使用量。

- `MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN`
  English: Dev-only override that disables the Node permission model for script/WASM child processes (the model is ON by default). Ignored — fail closed — when `NODE_ENV=production`. Replaces the retired `SCRIPT_CHILD_ENABLE_PERMISSION_MODEL` toggle, which no longer has any effect.
  中文：仅用于开发的覆盖项：关闭脚本/WASM 子进程的 Node permission model（默认开启）。当 `NODE_ENV=production` 时该覆盖被忽略（fail closed）。取代已失效的 `SCRIPT_CHILD_ENABLE_PERMISSION_MODEL`。

- `FEED_PRICE_PLANE`
  English: Which price plane serves `/feed/sign` in the Nitro enclave host. Unset, empty or `twelvedata` keeps the keyed TwelveData single-source plane — the default, and what every running system has today. `public-quorum` selects the key-free public-source quorum (`docs/FEED-PUBLIC-QUORUM.md`): three venues, a median, a 5 % deviation guard, and a single source refused. Any other value refuses to boot instead of silently falling back. Built dark (DEC-CU-30): it ships with the next enclave build, not before.
  中文：决定 Nitro enclave 主机的 `/feed/sign` 使用哪个价格通道。不写、留空或 `twelvedata` 使用带 key 的 TwelveData 单源通道——即默认值，也是当前所有运行中的系统所用的通道。`public-quorum` 选择无 key 的公开源 quorum（见 `docs/FEED-PUBLIC-QUORUM.md`）：三个数据源、取中位数、5% 偏差守卫，单一数据源直接拒绝。填写其他任何值都会拒绝启动，而不是静默回退。按 DEC-CU-30 以 dark 方式构建：随下一次 enclave 构建发布，在此之前不会生效。

- `MORPHEUS_RELAYER_ENCLAVE_FULFILL`
  English: Enables the compute-in-enclave fulfillment lane in the relayer. Required in production for `random.generate`: when `NODE_ENV=production` and this flag is unset, VRF fulfillment refuses the relayer-local `crypto.randomBytes` fallback and fails closed as a terminal config error (no retry, no on-chain failure callback). Rollout note: activate together with `NODE_ENV=production` on relayer services or VRF fulfillment halts.
  中文：在 relayer 中启用 enclave 内计算履约通道。生产环境 `random.generate` 必需：当 `NODE_ENV=production` 且未设置本标志时，VRF 履约拒绝 relayer 本地 `crypto.randomBytes` 回退并以 terminal config error fail closed（不重试、不上链失败回调）。上线注意：需与 relayer 服务的 `NODE_ENV=production` 配套启用，否则 VRF 履约会停止。

- `SCRIPT_CHILD_ALLOW_FS_READ`
- `SCRIPT_CHILD_ALLOW_FS_WRITE`
- `SCRIPT_CHILD_ALLOW_NET`
- `SCRIPT_CHILD_ALLOW_WORKER`
- `SCRIPT_CHILD_ALLOW_CHILD_PROCESS`
  English: Low-level overrides for child-process permissions.
  中文：脚本子进程底层权限覆盖项。

## Usually Safe To Ignore / 大多数时候你可以忽略

These exist for internal defaults or diagnostics.

这些变量主要是为了兼容、诊断或内部默认值。

- `LOG_FORMAT`, `LOG_LEVEL`
- `TXPROXY_ALLOWLIST`
- `WORKER_MAX_BODY_BYTES`
- `SCRIPT_WORKER_*`
- `WASM_CHILD_*`
- `MORPHEUS_MAX_SCRIPT_BYTES`
- `MORPHEUS_FEED_PAIR_REGISTRY_JSON`
- `MORPHEUS_RELAYER_STATE_FILE`
- `MORPHEUS_NITRO_TIMEOUT_MS`

## Worker Runtime Reference / Worker 运行时变量参考

Every variable below is read by the live workers (`workers/morpheus-relayer`,
`workers/nitro-worker`) but was previously documented nowhere. Names are
integration contracts with the systemd env files on the Nitro box — never
rename them. Format: default + one-line semantics.

下面的变量都被线上 worker（`workers/morpheus-relayer`、`workers/nitro-worker`）实际读取，
但之前没有任何文档。变量名是 Nitro box systemd env 文件的集成契约——绝不能改名。
格式：默认值 + 一句话语义。

### Custody Signer Service / 托管签名服务

- `SIGNER_SERVICE_URL` / `SIGNER_SERVICE_TOKEN`
  English: Base URL and bearer token of the custody signer service (inside the Nitro enclave). All Neo N3 signing — relayer lanes and both worker lanes (`handleSignPayload` / `buildSignedResultEnvelope`, `loadNeoN3Context` / `relayNeoN3Invocation`) — goes through it; neither the relayer nor the worker holds or reads any signing WIF. See `docs/SIGNER_SERVICE.md` §5.
  中文：托管签名服务（Nitro enclave 内）的地址与 Bearer token。全部 Neo N3 签名——relayer 各通道与 worker 两条通道（`handleSignPayload` / `buildSignedResultEnvelope`、`loadNeoN3Context` / `relayNeoN3Invocation`）——都经由它完成，relayer 与 worker 自身均不再持有或读取任何签名 WIF。见 `docs/SIGNER_SERVICE.md` §5。

- `SIGNER_ROLE_UPDATER_KEY_ID` / `SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID` / `SIGNER_ROLE_FEE_FUNDER_KEY_ID` / `SIGNER_ROLE_WORKER_KEY_ID`
  English: Custody key ids per signing role. Updater and oracle_verifier are required for the relayer's Neo N3 lanes; updater is also the tx-relay lane's on-chain identity on the worker (the lane relays oracle-contract invocations — `fulfillRequest` / `queueAutomationRequest` / `queueAutomationExecution` — as the updater account), and worker is required for the worker sign lane (`check-nitro-env.mjs` enforces all three); fee_funder is optional (auto fee top-up only, best-effort).
  中文：各签名角色对应的托管 key id。updater 与 oracle_verifier 是 relayer Neo N3 通道的必需项；updater 同时也是 worker tx-relay 通道的链上身份（该通道以 updater 账户转发 oracle 合约调用——`fulfillRequest` / `queueAutomationRequest` / `queueAutomationExecution`）；worker 是 worker 签名通道的必需项（`check-nitro-env.mjs` 强制校验）；fee_funder 可选（仅自动手续费补充，尽力而为）。

- `SIGNER_ROLE_NEOX_UPDATER_KEY_ID` / `SIGNER_ROLE_NEOX_VERIFIER_KEY_ID`
  English: Distinct NeoX custody roles. `NEOX_UPDATER` signs EIP-1559 transactions submitted to NeoX; `NEOX_VERIFIER` signs the semantic EIP-191 fulfillment proof consumed by the oracle contract. They must never resolve to the same key id.
  中文：相互独立的 NeoX 托管角色。`NEOX_UPDATER` 签署提交至 NeoX 的 EIP-1559 交易；`NEOX_VERIFIER` 签署预言机合约消费的语义化 EIP-191 履约证明。两者绝不能解析到同一个 key id。

### Signer Pinning And Network-Scoped Keys / 签名 pinning 与分网络密钥

- `MORPHEUS_ALLOW_UNPINNED_SIGNERS`
  English: Security toggle (default unset = pinned-only). When true-like, signer roles may fall back to unpinned key material instead of failing closed. A runtime env file that sets it true fails `scripts/check-nitro-env.mjs` (`forbidden_settings`); only the bootstrap files under `.secrets/` that `scripts/generate-nitro-signer-identity.mjs` generates may carry it true.
  中文：安全开关（默认不设置 = 只允许 pinned）。为 true 时 signer 角色可回退到未 pinned 的密钥材料，而不是直接失败。运行时 env 文件里为 true 会被 `scripts/check-nitro-env.mjs` 拒绝（`forbidden_settings`）；只有 `scripts/generate-nitro-signer-identity.mjs` 生成的 `.secrets/` 下 bootstrap 文件允许为 true。

- `MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET` / `MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET` (and `..._PRIVATE_KEY_{MAINNET,TESTNET}`)
  English: Network-scoped relayer signing material; takes precedence over the unscoped `MORPHEUS_RELAYER_NEO_N3_WIF` for that network. No signing lane reads these any more (all Neo N3 signing is custody-only since the custody migration); they remain consumed only by smoke tooling and the pinned-registry drift checks.
  中文：分网络 relayer 签名密钥；对应网络上优先于不带后缀的 `MORPHEUS_RELAYER_NEO_N3_WIF`。所有签名通道均已不再读取（custody 迁移后 Neo N3 签名只走托管服务）；目前仅冒烟工具与 pinned 注册表 drift 校验仍会消费。

- `MORPHEUS_UPDATER_NEO_N3_WIF` / `MORPHEUS_UPDATER_NEO_N3_WIF_{MAINNET,TESTNET}` (and `..._PRIVATE_KEY` forms)
  English: Dedicated feed-updater signing material; same network-scoped precedence rules as the relayer keys. No runtime lane reads these any more: the web control plane's feed-tick and callback-broadcast routes no longer resolve or forward signer material (the worker signs through custody under the updater role), leaving only smoke tooling and the pinned-registry drift checks.
  中文：feed updater 专用签名密钥；分网络优先级规则与 relayer 密钥相同。运行时通道均已不再读取：web 控制面的 feed-tick 与 callback-broadcast 路由不再解析或转发签名材料（worker 以 updater 角色经托管服务签名），仅剩冒烟工具与 pinned 注册表 drift 校验消费。

- `MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET` (and `_MAINNET`, `..._PRIVATE_KEY` forms)
  English: Network-scoped legacy verifier signing material; drift-check only. The runtime surface receives `MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_{MAINNET,TESTNET}` (public key) for on-chain result verification.
  中文：分网络的遗留 verifier 签名材料；仅用于 drift 校验。运行时表面只接收 `MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_{MAINNET,TESTNET}`（公钥），用于链上结果校验。

- `MORPHEUS_WORKER_NEO_N3_WIF_{MAINNET,TESTNET}` / `MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_{MAINNET,TESTNET}`
  English: Network-scoped worker Neo N3 signing material (legacy). No worker lane reads these any more — both worker lanes sign through the custody service (`SIGNER_ROLE_WORKER_KEY_ID`); the names remain only in the pinned-registry drift checks and legacy smoke tooling.
  中文：分网络的 worker Neo N3 签名材料（遗留）。worker 两条通道均已不再读取——签名一律走托管服务（`SIGNER_ROLE_WORKER_KEY_ID`）；该变量名仅存在于 pinned 注册表 drift 校验与旧的冒烟工具中。

- `NEO_TESTNET_WIF`
  English: Legacy generic testnet operator WIF accepted only by local smoke tooling and the pinned-registry drift checks; no runtime lane reads it.
  中文：旧的通用 testnet WIF，仅本地冒烟工具与 pinned 注册表 drift 校验接受；运行时通道均不读取。

### RPC Endpoint Aliases / RPC 地址别名

- `NEO_RPC_URL_MAINNET` / `NEO_RPC_URL_TESTNET`
  English: Network-scoped Neo N3 RPC endpoints; preferred over the generic `NEO_RPC_URL` when the relayer pins a network.
  中文：分网络 Neo N3 RPC 地址；relayer 固定网络时优先于通用 `NEO_RPC_URL`。

- `NEO_RPC_URLS`, `NEO_RPC_URLS_MAINNET`, `NEO_RPC_URLS_TESTNET`, `NEO_MAINNET_RPC_URLS`, `MAINNET_RPC_URLS`, `NEO_MAINNET_RPC_URL`, `MAINNET_RPC_URL`, `NEO_RPC_MAINNET`
  English: Comma-separated failover RPC lists plus accepted legacy single-URL aliases, merged in that order.
  中文：逗号分隔的 RPC failover 列表以及兼容的旧单地址别名，按该顺序合并。

- `ALLOW_GENERIC_NEO_RPC_URL`
  English: Default false. When true, the generic `NEO_RPC_URL(S)` values are also merged into a network-pinned RPC pool.
  中文：默认 false。为 true 时，通用 `NEO_RPC_URL(S)` 也会并入已固定网络的 RPC 池。

### Relayer Operations / Relayer 运行参数

- `MORPHEUS_RELAYER_MODE`
  English: Production Rust lane selection: `requests_only`, `feed_only`, or `combined` (also the default when unset).
  中文：生产 Rust 通道选择：`requests_only`、`feed_only` 或 `combined`（不设置时也默认 combined）。

- `MORPHEUS_FEED_SYNC_ENABLED` / `MORPHEUS_FEED_SYMBOLS`
  English: `feed_only` requires sync enabled and at least one comma-separated symbol; config validation and runtime readiness both fail closed otherwise. `combined` may explicitly disable feed sync and operate as a request-only deployment; when feed sync is enabled it has the same symbol requirement.
  中文：`feed_only` 必须启用同步并至少配置一个逗号分隔的 symbol，否则配置校验与运行时就绪检查都会失败关闭。`combined` 可显式关闭 feed sync 并退化为仅请求部署；启用 feed sync 时同样必须配置 symbol。

- `MORPHEUS_RELAYER_NEOX_ORACLE` / `MORPHEUS_RELAYER_NEOX_DATAFEED`
  English: NeoX oracle and datafeed contract addresses. Request mode requires the oracle address; an enabled feed mode requires the datafeed address.
  中文：NeoX oracle 与 datafeed 合约地址。request 模式需要 oracle 地址；启用 feed 时需要 datafeed 地址。

- `MORPHEUS_RELAYER_MAX_CALLBACK_RETRIES`
  English: Default `maxRetries * 2`. Retry ceiling for prepared-callback and finalize-only redelivery before the event is dead-lettered.
  中文：默认 `maxRetries * 2`。prepared callback / finalize-only 重投的重试上限，超过即进入 dead letter。

- `MORPHEUS_RELAYER_HEALTH_MAX_STALE_MS`
  English: Default 120000. Healthcheck fails when the relayer heartbeat state is older than this.
  中文：默认 120000。relayer 心跳状态超过该时长未更新时健康检查判定失败。

- `MORPHEUS_RELAYER_STATE_PERSIST_MIN_INTERVAL_MS`
  English: Default 250. Minimum interval between relayer state-file persists.
  中文：默认 250。relayer 状态文件两次落盘之间的最短间隔。

- `MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID`
  English: Optional request-id cursor override used when no checkpoint exists for the request lane.
  中文：request 通道没有 checkpoint 时使用的可选起始 request id。

- `MORPHEUS_RELAYER_NEOX_CONFIRM_TIMEOUT_MS`
  English: Default 45000. Confirmation wait budget for the NeoX EVM lane.
  中文：默认 45000。NeoX EVM 通道等待交易确认的超时。

- `MORPHEUS_RELAYER_LOG_LEVEL` / `MORPHEUS_RELAYER_LOG_FORMAT`
  English: Relayer-specific overrides for `LOG_LEVEL` / `LOG_FORMAT`.
  中文：relayer 专用的 `LOG_LEVEL` / `LOG_FORMAT` 覆盖项。

- `MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED`
  English: Defaults to the value of `MORPHEUS_DURABLE_QUEUE_ENABLED`. When true, durable-queue persistence failures block checkpoint advance instead of failing open.
  中文：默认跟随 `MORPHEUS_DURABLE_QUEUE_ENABLED`。为 true 时，持久化队列写入失败会阻止 checkpoint 前进，而不是放行。

- `MORPHEUS_SUPABASE_BACKOFF_MS` (legacy alias `SUPABASE_BACKOFF_MS`)
  English: Default 300000. Cooldown before retrying Supabase persistence after repeated failures.
  中文：默认 300000。Supabase 持久化连续失败后的重试冷却时间。

- `MORPHEUS_HEARTBEAT_TIMEOUT_MS`
  English: Default 3000 (minimum 250). HTTP timeout for BetterStack heartbeat pings.
  中文：默认 3000（最小 250）。BetterStack 心跳请求的 HTTP 超时。

### BetterStack Telemetry / BetterStack 遥测

- `MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL` / `MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL` / `MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL`
  English: Optional heartbeat URLs for the request lane, the feed lane, and explicit failure reporting; unset disables the ping.
  中文：request 通道、feed 通道和失败上报的可选心跳地址；不设置则不发送。

- `MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN` / `MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST`
  English: Log-shipping credentials; both must be set to enable the BetterStack log sink.
  中文：日志上报凭据；两者都设置后才启用 BetterStack 日志通道。

- `MORPHEUS_BETTERSTACK_LOG_BATCH_SIZE` (default 20) / `MORPHEUS_BETTERSTACK_LOG_FLUSH_INTERVAL_MS` (default 2000) / `MORPHEUS_BETTERSTACK_LOG_TIMEOUT_MS` (default 2000) / `MORPHEUS_BETTERSTACK_LOG_MAX_QUEUE` (default 500)
  English: Batching, flush cadence, request timeout, and bounded-queue size for the log sink.
  中文：日志通道的批量大小、刷新周期、请求超时和队列上限。

### Worker Capacity And Providers / Worker 容量与数据源

- `MORPHEUS_MAX_INFLIGHT_ORACLE_QUERY` (default 16), `MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE`, `MORPHEUS_MAX_INFLIGHT_RELAY_TRANSACTION` (default 6)
  English: Per-route in-flight request ceilings in the worker overload guard; `0` disables the cap for that route. Other routes follow the same `MORPHEUS_MAX_INFLIGHT_<ROUTE>` pattern (vrf*random 4, paymaster_authorize 8, oracle_smart_fetch 12, txproxy_invoke 12).
  中文：worker 过载保护的分路由并发上限；`0` 表示该路由不限。其他路由遵循同样的 `MORPHEUS_MAX_INFLIGHT*<ROUTE>` 命名（vrf_random 4、paymaster_authorize 8、oracle_smart_fetch 12、txproxy_invoke 12）。

- `MORPHEUS_PROVIDER_FETCH_RETRIES`
  English: Default 2. Retry count for upstream market-data provider fetches.
  中文：默认 2。上游行情 provider 拉取的重试次数。

- `MORPHEUS_PROVIDER_FAILURE_THRESHOLD` (default 3) / `MORPHEUS_PROVIDER_RESET_TIMEOUT_MS` (default 60000)
  English: Circuit-breaker trip threshold and reset window for failing providers.
  中文：provider 熔断的失败阈值与恢复窗口。

- `MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS`
  English: TTL for the short-lived provider response cache.
  中文：provider 响应短缓存的 TTL。

- `MORPHEUS_AGGREGATION_METHOD`
  English: Default `median`. Aggregation method when multiple providers serve one pair.
  中文：默认 `median`。多 provider 喂同一交易对时的聚合方法。

- `MORPHEUS_FEED_STATE_PATH`
  English: Default `/data/morpheus-feed-state.json`. Filesystem path for the persisted feed scheduler state.
  中文：默认 `/data/morpheus-feed-state.json`。feed 调度器持久化状态的文件路径。

- `MORPHEUS_FEED_SYNC_TIMEOUT_MS`
  English: Default 10000 (minimum 1000). Per-pair timeout inside a feed sync pass.
  中文：默认 10000（最小 1000）。一次 feed 同步里单个交易对的超时。

- `MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED` / `MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED`
  English: Toggles for bootstrapping feed state from Supabase and for writing feed snapshots back to Supabase.
  中文：从 Supabase 引导 feed 状态、以及把 feed 快照写回 Supabase 的开关。

- `MORPHEUS_MAX_REGISTERED_SCRIPT_BYTES`
  English: Default 65536. Size cap for registered compute scripts.
  中文：默认 65536。注册 compute 脚本的大小上限。

- `COMPUTE_MAX_INPUT_BYTES` / `COMPUTE_MAX_ZKP_VERIFY_INPUT_BYTES` / `ORACLE_MAX_SCRIPT_INPUT_BYTES` / `ORACLE_MAX_UPSTREAM_BODY_BYTES`
  English: Input/body size caps for compute payloads, ZKP verification inputs, oracle script inputs, and generic upstream responses.
  中文：compute 入参、ZKP 校验入参、oracle 脚本入参和通用上游响应体的大小上限。

- `MORPHEUS_ZKP_VERIFY_RUNTIME` / `MORPHEUS_ZKP_VERIFY_TIMEOUT_MS` / `MORPHEUS_SNARKJS_BIN`
  English: ZKP verification runtime selection, timeout, and snarkjs binary override.
  中文：ZKP 校验的运行时选择、超时和 snarkjs 可执行文件覆盖。

- `ORACLE_HTTP_ALLOWLIST`
  English: Comma-separated host allowlist for raw oracle HTTP fetches.
  中文：oracle 原始 HTTP 拉取允许访问的主机列表，逗号分隔。

### Nitro Signer And AWS Integration / Nitro 签名器与 AWS 集成

- `NITRO_SIGNER_ENDPOINT` (alias `MORPHEUS_NITRO_SIGNER_ENDPOINT`)
  English: Default `http://127.0.0.1:8787`. The frontier enclave, used only for the `/health` runtime marker and the `/attestation` NSM document. It holds no signing key — signing goes to the custody enclave via `SIGNER_SERVICE_URL`.
  中文：默认 `http://127.0.0.1:8787`。frontier enclave，仅用于 `/health` 运行时标记与 `/attestation` NSM 证明文档。它不持有签名密钥——签名走 custody enclave 的 `SIGNER_SERVICE_URL`。

- `NITRO_ATTEST_ENDPOINT`
  English: Defaults to `NITRO_SIGNER_ENDPOINT`. Endpoint used to fetch Nitro attestation documents.
  中文：默认等于 `NITRO_SIGNER_ENDPOINT`。获取 Nitro attestation 文档的地址。

- `NITRO_EMIT_ATTESTATION`
  English: When true-like, worker responses can attach Nitro (NSM) attestation metadata.
  中文：为 true 时 worker 响应可以附带 Nitro (NSM) attestation 元数据。

- `NITRO_USE_DERIVED_KEYS`
  English: Enables derived role keys via the signer.
  中文：通过 signer 启用派生角色密钥。

- `NITRO_X25519_SECRET_ID` (default `morpheus/x25519-wrap`) / `NITRO_NEODID_SALT_SECRET_ID` (default `morpheus/neodid-salt`)
  English: AWS Secrets Manager secret ids for the oracle transport wrapping key and the NeoDID salt.
  中文：oracle 传输封装密钥与 NeoDID salt 在 AWS Secrets Manager 中的 secret id。

- `AWS_REGION`
  English: Default `us-east-1`. Region for the Secrets Manager lookups above.
  中文：默认 `us-east-1`。上述 Secrets Manager 访问使用的区域。

- `PORT` / `NITROCORE_PORT`
  English: Worker HTTP listen port, checked in that order.
  中文：worker HTTP 监听端口，按该顺序取值。

### Oracle Key Material Overrides / Oracle 密钥材料覆盖

- `MORPHEUS_ORACLE_KEY_MATERIAL_JSON` / `MORPHEUS_ORACLE_KEY_MATERIAL_BASE64` / `MORPHEUS_ORACLE_PRIVATE_KEY_PKCS8` / `MORPHEUS_ORACLE_PUBLIC_KEY_RAW`
  English: Explicit oracle X25519 transport-key injection; takes precedence over sealed-keystore and derived-key paths.
  中文：显式注入 oracle X25519 传输密钥；优先于封装 keystore 与派生密钥路径。

- `MORPHEUS_ALLOW_EPHEMERAL_KEY`
  English: Default false. In non-production development, allows a process-lifetime ephemeral oracle key when no stable key source is available — decryptability ends with the process. The worker rejects this opt-in when `NODE_ENV=production` and logs stable/configured key-source failures before any development fallback.
  中文：默认 false。在非生产开发环境中，没有稳定密钥来源时允许使用进程级临时 oracle 密钥——进程结束后密文不可解。`NODE_ENV=production` 时 worker 会拒绝此选项，并在开发回退前记录稳定/显式密钥来源失败。

- `NEODID_SECRET_SALT`
  English: NeoDID commitment salt. NeoDID digest signatures are custody-side (the enclave signs under `SIGNER_ROLE_WORKER_KEY_ID`); there is no `NEODID_NEO_N3_PRIVATE_KEY` any more.
  中文：NeoDID 承诺 salt。NeoDID 摘要签名走托管服务（enclave 以 `SIGNER_ROLE_WORKER_KEY_ID` 签名）；`NEODID_NEO_N3_PRIVATE_KEY` 已移除。

### Chain Write Safety Toggles / 链上写入安全开关

- `MORPHEUS_ALLOW_RAW_BROADCAST`
  English: Default false. Required for the raw signed-transaction broadcast route.
  中文：默认 false。开启后才允许广播原始已签名交易。

- `MORPHEUS_ALLOW_GLOBAL_SCOPE`
  English: Default false. Allows Global witness scope in sponsored transactions instead of CalledByEntry.
  中文：默认 false。允许代付交易使用 Global witness scope，而不是 CalledByEntry。

- `MORPHEUS_MAX_SPONSOR_FEE_GAS`
  English: Default 10. Cap (in GAS) on the network fee the sponsor lane will pay per transaction.
  中文：默认 10。代付通道单笔交易愿意承担的网络费上限（GAS）。

- `MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP`
  English: Default false. The raw `/relay/transaction` sponsorship path stays disabled until this explicit runtime gate is enabled. Enabled requests must also provide an unsigned-transaction `operation_hash`, target contract, and method that match the transaction script.
  中文：默认 false。原始 `/relay/transaction` 代付路径保持关闭；只有显式开启此运行时开关，且请求提供与交易脚本一致的 unsigned `operation_hash`、目标合约和方法时才会处理。

### Paymaster (Testnet Lane) / Paymaster（testnet 通道）

- `MORPHEUS_PAYMASTER_TESTNET_ENABLED` / `MORPHEUS_PAYMASTER_MAINNET_ENABLED`
  English: Per-network paymaster enablement; mainnet defaults to disabled.
  中文：分网络 paymaster 开关；mainnet 默认关闭。

- `MORPHEUS_PAYMASTER_TESTNET_AA_CORE_HASH` / `_MULTI_HOOK_HASH` / `_WHITELIST_HOOK_HASH` / `_POLICY_ID` / `_NEO_RPC_URL` / `_MAX_GAS_UNITS`
  English: Testnet paymaster wiring: AA core and hook contract hashes, policy id, RPC override, and per-op gas ceiling.
  中文：testnet paymaster 接线：AA core 与 hook 合约地址、policy id、RPC 覆盖和单次操作 gas 上限。

- `MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS` / `_ALLOW_DAPPS` / `_ALLOW_TARGETS` / `_ALLOW_METHODS` / `_BLOCK_ACCOUNTS`
  English: Comma-separated allow/deny lists evaluated before sponsoring a user operation.
  中文：代付前检查的逗号分隔允许/拒绝清单。

- `MORPHEUS_PAYMASTER_TESTNET_ALLOW_USEROP_TARGETS` / `MORPHEUS_PAYMASTER_MAINNET_ALLOW_USEROP_TARGETS`
  English: Explicit inner-contract allowlists for AA user operations when an on-chain whitelist hook is not configured. User operations fail closed unless this list or the on-chain hook policy is configured.
  中文：AA user operation 未配置链上白名单 hook 时使用的内层合约白名单；两种策略都未配置时拒绝代付。

### NeoX Message Lane / NeoX 消息通道

- `NEOX_MESSAGE_RPC` (aliases `NEOX_RPC`, `EVM_RPC_URL`) / `NEOX_MESSAGE_CONTRACT` / `NEOX_MESSAGE_CHAIN_ID` (alias `NEOX_CHAIN_ID`)
  English: EVM RPC endpoint, message contract address, and chain id for the NeoX encrypted-message reveal lane.
  中文：NeoX 加密消息 reveal 通道使用的 EVM RPC、消息合约地址和 chain id。

### Misc Aliases / 其他别名

- `SUPABASE_SERVICE_KEY`
  English: Additional legacy alias for the Supabase server key, read after `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY`.
  中文：Supabase 服务端 key 的另一个旧别名，排在 `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 之后读取。

- `MORPHEUS_RUNTIME_CONFIG_JSON`
  English: JSON blob carrying runtime configuration injected by the deployment env files; individual env vars override its fields.
  中文：部署 env 文件注入的运行时 JSON 配置；单独的环境变量优先于其中字段。

- `CONTRACT_MORPHEUS_ORACLE_HASH_{MAINNET,TESTNET}` / `CONTRACT_MORPHEUS_DATAFEED_HASH_{MAINNET,TESTNET}`
  English: Network-scoped contract-hash overrides preferred over the unscoped names when the network is pinned.
  中文：分网络合约地址覆盖项；固定网络时优先于不带后缀的变量。

- `CONTRACT_PRICEFEED_HASH`
  English: Legacy alias still accepted for the datafeed contract hash.
  中文：datafeed 合约地址仍然接受的旧别名。

- `MORPHEUS_OPERATION_LOG_SAMPLE_RATE`
  English: Default 20. Web app only: 1-in-N sampling rate for successful monitoring GET operation logs (`1` logs every probe).
  中文：默认 20。仅 web 应用使用：成功的监控类 GET 操作日志按 1/N 采样（设为 `1` 则每次都记录）。

## Practical Advice / 实操建议

If you are the operator of this stack, the shortest checklist is:

如果你是这套系统的运维者，最短的检查清单只有下面这些：

1. Make sure all contract addresses match the live deployed contracts.
   确认所有合约地址与当前实际部署一致。
2. Make sure updater / relayer keys still control the configured updater accounts.
   确认 updater / relayer 私钥仍然对应当前链上 updater 账户。
3. Make sure `NITRO_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, and `TWELVEDATA_API_KEY` are valid.
   确认 `NITRO_API_TOKEN`、`SUPABASE_SERVICE_ROLE_KEY`、`TWELVEDATA_API_KEY` 都是有效的。
4. Keep `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS` unset unless you intentionally want user JS execution.
   除非你明确要支持用户 JS 脚本，否则保持 `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS` 不设置。
5. Tune `MORPHEUS_WASM_TIMEOUT_MS` instead of changing hardcoded timeouts in code.
   想调整 WASM 执行时间时，改 `MORPHEUS_WASM_TIMEOUT_MS`，不要改代码里的硬编码。
