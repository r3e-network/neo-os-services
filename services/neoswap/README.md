# NeoSwap v2 Service Components

## Overview

这些是 NeoSwap v2 的可选服务组件。生产 NeoSwap 小程序的第三方 provider 兑换链路不依赖这里的本地订单簿或模拟流动性。

1. **Routing Engine (Node.js)** - 基于真实池快照的路径计算与风险扫描
2. **Order Matcher (Node.js)** - 订单簿撮合引擎；没有有效 WASM 工件时使用可审计的确定性实现
3. **TWAP Oracle Aggregator (Node.js)** - 多源价格聚合器
4. **API Gateway (Next.js 14)** - API 聚合网关
5. **Price Feed Service** - WebSocket 价格推送服务器
6. **Analytics Dashboard API** - 分析仪表盘 API

## Quick Start with Docker Compose

```bash
# 一键启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止所有服务
docker-compose down
```

## Service Details

### 1. Routing Engine (Port: 3002)

**功能**:

- 基于池快照的多跳路径计算
- MEV 风险扫描和前端保护
- 流动性深度分析

**API**:

- `GET /api/v1/quote` - 获取报价
- `POST /api/v1/route` - 计算最优路径

### 2. Order Matcher (Port: 3003)

**功能**:

- SQLite 订单簿持久化
- 确定性撮合逻辑；WASM 工件接入前不会宣称已执行 WASM
- 双签名验证机制

**API**:

- `POST /api/v1/order` - 提交限价订单
- `DELETE /api/v1/order/{id}` - 取消订单
- `GET /api/v1/orders/{user-id}` - 查询订单历史

### 3. TWAP Oracle Aggregator (Port: 8080/8081)

**功能**:

- 多源价格接入接口与真实 tick 存储
- 未配置 provider 时 fail-closed，不生成随机价格
- TimescaleDB 存储历史数据
- WebSocket 实时推送

**WebSocket**:

- Connect to `ws://localhost:8080`
- Subscribe: `{"type": "subscribe", "tokens": ["NEO/USDT"]}`
- Request TWAP: `{"type": "request_twap", "tokenPair": "NEO/USDT"}`

**HTTP**:

- `GET /metrics` - Prometheus metrics

### 4. API Gateway (Port: 3001)

**功能**:

- `/api/v1/quote` 聚合报价接口
- Redis TTL 缓存（10s）
- 租户隔离速率限制

**API**:

- `GET /api/v1/quote?tokenIn=...&tokenOut=...&amount=...`
- `POST /api/v1/swap` - 执行交换
- `GET /api/v1/pools` - 查询流动性池

### 5. Price Feed Service (Port: 8081)

**功能**:

- WebSocket 服务器支持 10,000+ 并发连接
- P99 延迟 < 50ms
- Backpressure 处理机制

**Connection**:

- WebSocket URL: `wss://price-feed:8081`
- Health check: `http://price-feed:8081/metrics`

### 6. Analytics Dashboard API (Port: 3005)

**功能**:

- Postgres + TimescaleDB
- 交易历史记录查询
- PnL 计算器
- CSV/PDF 导出

**API**:

- `GET /api/v1/history/{user-id}` - 查询交易历史
- `GET /api/v1/pnl/{user-id}` - 计算盈亏
- `POST /api/v1/export` - 导出数据 (CSV/PDF)

## Performance Metrics

| Service        | Target P99 Latency | QPS Capacity  | Evidence             |
| -------------- | ------------------ | ------------- | -------------------- |
| Routing Engine | 25ms               | 1,000+        | 仅有单元测试，需压测 |
| Order Matcher  | 5ms                | 5,000+        | 仅有单元测试，需压测 |
| API Gateway    | 10ms               | 10,000+       | 需部署验证           |
| Price Feed     | 2ms                | 50,000+ msg/s | 仅有单元测试，需压测 |
| Analytics API  | 50ms               | 500+          | 需数据库验证         |

## Monitoring Stack

### Prometheus (Port: 9090)

所有微服务自动暴露 `/metrics` 端点

主要指标包括：

- `neoswap_routing_requests_total` - 请求计数
- `neoswap_api_request_duration_seconds` - API 延迟
- `neoswap_price_feed_active_connections` - WebSocket 连接数
- `neoswap_pool_liquidity_usd` - 池子流动性

### Grafana (Port: 3006)

凭证必须通过部署环境的 secret manager 注入，仓库不提供默认凭证。

预配置仪表板：

- **NeoSwap Overview** - 整体系统监控
- **Routing Engine Analysis** - 路由性能分析
- **Price Feed Dashboard** - 价格推送监控
- **Analytics & Export** - 分析导出统计

## Unit Test Coverage

所有服务均实现 Vitest 单元测试框架，覆盖率要求≥85%

测试命令：

```bash
cd services/neoswap/<service-name>
npm test
```

覆盖率必须在当前构建中生成并记录；通过单元测试不代表已完成生产压测、链上验证或 provider 可用性验证。

## Architecture Patterns

### Service Discovery & Health Checks

所有服务通过 Docker Compose healthcheck 进行健康检查：

- 检查间隔：30 秒
- 超时时间：10 秒
- 失败重试：3 次

### Rate Limiting & Tenant Isolation

API Gateway 实现三层租户策略：

- Free: 100 req/min
- Standard: 1,000 req/min
- Premium: 10,000 req/min

### Caching Strategy

使用 Redis 多层缓存：

- Route Cache: TTL 10s
- Pool Info: TTL 300s
- User Session: TTL 3600s

### Data Persistence

- Orders: SQLite (in-memory for performance)
- Trades: TimescaleDB (time-series optimized)
- Cache: Redis (high-speed)

## Security Features

1. **MEV Protection**
   - Front-run detection
   - Sandwich attack prevention
   - Suggested slippage calculation

2. **Dual Signature Verification**
   - Large trades (> $10k) require dual signature
   - EdDSA signing with TweetNaCl

3. **WASM Sandboxing**
   - Order matching logic isolated in WASM
   - Resource limits enforced

4. **Rate Limiting**
   - Tenant-specific limits
   - IP-based abuse protection

## Deployment Checklist

- [ ] Update database passwords in docker-compose.yml
- [ ] Configure Redis connection strings
- [ ] Set environment variables (.env files)
- [ ] Verify port availability (3001-3006, 5432, 6379, 8080-8082)
- [ ] Run database migrations
- [ ] Configure load balancer (optional for production)
- [ ] Enable SSL/TLS termination

## Troubleshooting

### Services not starting

```bash
docker-compose ps
docker-compose logs <service-name>
```

### Database connection issues

```bash
docker exec -it neoswap-postgres-1 psql -U neoswap -d neoswap_analytics
```

### Redis connectivity

```bash
docker exec -it neoswap-redis-fast-1 redis-cli ping
```

## Future Enhancements

- [ ] Kubernetes deployment configuration
- [ ] Multi-region replication
- [ ] Real-time trading bot integration
- [ ] Cross-chain bridge support
- [ ] Advanced order types (stop-loss, trailing-stop)

## License

MIT License - See LICENSE file for details
