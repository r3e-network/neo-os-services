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

## Must Know / 你必须关心的变量

These are the variables that matter for day-to-day operation.
If one of these is wrong, the system usually stops working.

这些是日常运行最关键的变量。
其中任意一个出错，系统通常就会停止工作。

### Runtime Access / Runtime 访问

- `MORPHEUS_RUNTIME_URL`
  English: Preferred public URL of the unified Morpheus runtime. The web app and scripts should use this first.
  中文：统一 Morpheus runtime 的优先公网地址。前端和运维脚本应优先使用它。

- `MORPHEUS_MAINNET_RUNTIME_URL` / `MORPHEUS_TESTNET_RUNTIME_URL`
  English: Optional network-scoped runtime URLs when you want explicit mainnet/testnet separation.
  中文：可选的分网络 runtime 地址，用于显式区分 mainnet/testnet。

- `MORPHEUS_BOX_HEALTH_URL_MAINNET` / `MORPHEUS_BOX_HEALTH_URL_TESTNET`
  English: Network-scoped health endpoints for the attested box used by `apps/web` runtime status. Configure both in production; a URL may contain the `{network}` placeholder. A generic `MORPHEUS_BOX_HEALTH_URL` is only a fallback and a reported network mismatch is fail-closed.
  中文：`apps/web` runtime status 使用的 attested box 分网络健康地址。生产环境应同时配置两项；地址可包含 `{network}` 占位符。通用的 `MORPHEUS_BOX_HEALTH_URL` 仅作 fallback，若返回的 network 不匹配会 fail-closed。

- `MORPHEUS_RUNTIME_TOKEN`
- `NITRO_API_TOKEN` or `NITRO_SHARED_SECRET`
  English: Authentication secret for the runtime. Prefer `MORPHEUS_RUNTIME_TOKEN`.
  中文：runtime 的鉴权密钥。优先使用 `MORPHEUS_RUNTIME_TOKEN`。

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

- `MORPHEUS_RELAYER_ADMIN_API_KEY`
  English: Admin key for relayer metrics, jobs, retry, and replay routes.
  中文：relayer 监控、任务、重试、重放接口使用的管理员 key。

- `MORPHEUS_SIGNING_ADMIN_API_KEY`
  English: Admin key for `/api/sign/payload`.
  中文：`/api/sign/payload` 使用的管理员 key。

- `MORPHEUS_RELAY_ADMIN_API_KEY`
  English: Admin key for `/api/relay/transaction`.
  中文：`/api/relay/transaction` 使用的管理员 key。

- `MORPHEUS_OPERATOR_API_KEY`
  English: Optional wider-scope operator key that can act as a shared fallback for relayer/signing/relay admin routes.
  中文：可选的运维总控 key，可作为 relayer / 签名 / relay 管理接口的共享回退 key。

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
  English: Worker-side Neo N3 signing material.
  中文：worker 使用的 Neo N3 签名私钥。

- `MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY` or `MORPHEUS_ORACLE_VERIFIER_WIF`
  English: Preferred dedicated Neo N3 signer for async Oracle fulfillment signatures.
  中文：异步 Oracle fulfill 签名优先使用的独立 Neo N3 signer。

- `NEO_N3_WIF`
  English: Preferred generic Neo N3 operator WIF for local scripts and deploy helpers.
  中文：本地脚本和部署辅助工具优先使用的通用 Neo N3 WIF。

- `MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY` or `MORPHEUS_RELAYER_NEO_N3_WIF`
  English: Relayer/updater Neo N3 signing material.
  中文：relayer / updater 使用的 Neo N3 签名私钥。

  English: If the dedicated `oracle_verifier` role is unset and the derived signer is unavailable, the worker can fall back to its general Neo N3 signing material.
  中文：如果没有单独设置 `oracle_verifier` signer，且派生 signer 也不可用，worker 会回退到通用的 Neo N3 签名材料。

  English: The generated testnet Nitro env now disables derived signing by default when it injects an explicit verifier signer, so the published testnet verifier key is not accidentally shadowed by a derived role key.
  中文：现在生成的 testnet Nitro env 在注入显式 verifier signer 时会默认关闭派生签名覆盖，避免已发布到链上的 testnet verifier key 被派生角色密钥意外替换。

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
  English: Comma-separated active chain list for relayer scanning and automatic feed sync. Current production default should be `neo_n3`.
  中文：relayer 扫链和自动 feed 同步所使用的活动链列表，逗号分隔。当前生产默认应该是 `neo_n3`。

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
  English: Enables the relayer automation scheduler.
  中文：开启 relayer 自动化调度器。

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

- `MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN`
  English: Dev-only override that disables the Node permission model for script/WASM child processes (the model is ON by default). Ignored — fail closed — when `NODE_ENV=production`. Replaces the retired `SCRIPT_CHILD_ENABLE_PERMISSION_MODEL` toggle, which no longer has any effect.
  中文：仅用于开发的覆盖项：关闭脚本/WASM 子进程的 Node permission model（默认开启）。当 `NODE_ENV=production` 时该覆盖被忽略（fail closed）。取代已失效的 `SCRIPT_CHILD_ENABLE_PERMISSION_MODEL`。

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

### Signer Pinning And Network-Scoped Keys / 签名 pinning 与分网络密钥

- `MORPHEUS_ALLOW_UNPINNED_SIGNERS`
  English: Security toggle (default unset = pinned-only). When true-like, signer roles may fall back to unpinned key material instead of failing closed.
  中文：安全开关（默认不设置 = 只允许 pinned）。为 true 时 signer 角色可回退到未 pinned 的密钥材料，而不是直接失败。

- `MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET` / `MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET` (and `..._PRIVATE_KEY_{MAINNET,TESTNET}`)
  English: Network-scoped relayer signing material; takes precedence over the unscoped `MORPHEUS_RELAYER_NEO_N3_WIF` for that network.
  中文：分网络 relayer 签名密钥；对应网络上优先于不带后缀的 `MORPHEUS_RELAYER_NEO_N3_WIF`。

- `MORPHEUS_UPDATER_NEO_N3_WIF` / `MORPHEUS_UPDATER_NEO_N3_WIF_{MAINNET,TESTNET}` (and `..._PRIVATE_KEY` forms)
  English: Dedicated feed-updater signing material; same network-scoped precedence rules as the relayer keys.
  中文：feed updater 专用签名密钥；分网络优先级规则与 relayer 密钥相同。

- `MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET` (and `_MAINNET`, `..._PRIVATE_KEY` forms)
  English: Network-scoped async-fulfillment verifier signer; overrides the unscoped verifier names on that network.
  中文：分网络异步 fulfill verifier signer；对应网络上覆盖不带后缀的 verifier 变量。

- `MORPHEUS_WORKER_NEO_N3_WIF_{MAINNET,TESTNET}` / `MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_{MAINNET,TESTNET}`
  English: Network-scoped worker Neo N3 signing material; overrides the unscoped worker key on the matching network.
  中文：分网络的 worker Neo N3 签名材料；在对应网络上覆盖不带后缀的 worker 密钥。

- `NEO_TESTNET_WIF`
  English: Legacy generic testnet operator WIF accepted as a low-priority fallback by scripts and signer resolution.
  中文：旧的通用 testnet WIF，脚本与 signer 解析会作为低优先级回退接受。

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
  English: Lane selection: `requests_only` (oracle CVM), `feed_only` (datafeed CVM), or unset for both lanes.
  中文：通道选择：`requests_only`（oracle CVM）、`feed_only`（datafeed CVM），不设置则两条通道都跑。

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
  English: Default `http://127.0.0.1:8787`. Enclave signer endpoint holding the Neo signing keys.
  中文：默认 `http://127.0.0.1:8787`。持有 Neo 签名密钥的 enclave signer 地址。

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

- `NEODID_SECRET_SALT` / `NEODID_NEO_N3_PRIVATE_KEY`
  English: NeoDID commitment salt and dedicated signer overrides.
  中文：NeoDID 承诺 salt 与专用 signer 覆盖项。

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
