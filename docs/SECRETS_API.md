# Secrets API（开发者自助 Secret 管理）

> P0-2 里程碑：对齐 Chainlink CRE 的 secrets 托管语义（部署时绑定、运行时读取、可轮换、可过期），保持中心化服务形态。Ciphertext 始终由客户端用 Oracle 公钥密封（`X25519-HKDF-SHA256-AES-256-GCM`），服务端只存储不透明密文，**永不接触明文**。

## 与 operator 通道的区别

| 通道                 | 端点                           | 鉴权                                  | 用途                               |
| -------------------- | ------------------------------ | ------------------------------------- | ---------------------------------- |
| Operator（既有）     | `POST /api/confidential/store` | admin key                             | 运维/provider 配置的大密文引用     |
| **开发者（本 API）** | `/api/registry/secrets`        | Supabase 用户 JWT + project ownership | 应用自行管理自己的 secret 生命周期 |

## 鉴权

- `Authorization: Bearer <supabase-user-jwt>`。
- 授权依据 `morpheus_projects.owner_user_id = <user.id>`（与 RLS 一致）。
- 不属于自己的 project/secret 统一返回 404，不泄露归属。

## 存储 secret

```bash
curl -X POST https://<web>/api/registry/secrets \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <supabase-user-jwt>' \
  -d '{
    "project_slug": "acme",
    "name": "twelvedata-key",
    "ciphertext": "<client-sealed ciphertext>",
    "target_chain": "neo_n3",
    "expires_at": "2026-12-31T00:00:00.000Z"
  }'
```

返回 201 + 记录（不含 ciphertext），`secret_ref` 即 UUID，可直接作为链上 `encrypted_params_ref`。

## 列出自己的 secrets

```bash
curl 'https://<web>/api/registry/secrets?project_slug=acme' \
  -H 'Authorization: Bearer <supabase-user-jwt>'
```

返回 `{ project_slug, network, secrets: [...] }`。列表**永不含 ciphertext**，仅元数据（`secret_ref`、`name`、`key_version`、`expires_at` 等）。

## 轮换（替换 ciphertext）

```bash
curl -X PATCH https://<web>/api/registry/secrets/<secret_ref> \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <supabase-user-jwt>' \
  -d '{ "ciphertext": "<new client-sealed ciphertext>" }'
```

- 提供 `ciphertext` 时自动 `key_version + 1`（轮换语义）。
- 也可单独更新 `name`、`metadata`、`expires_at`（此时 key_version 不变）。

## 删除

```bash
curl -X DELETE https://<web>/api/registry/secrets/<secret_ref> \
  -H 'Authorization: Bearer <supabase-user-jwt>'
```

硬删除（ciphertext ref 本质敏感且临时，不做软删除保留）。

## 校验规则

- `ciphertext`：必填、非空、≤ 256 KiB。
- `expires_at`：可选，ISO-8601，必须为未来时间；`null` 表示不过期。
- `target_chain`：当前仅 `neo_n3`。
- 名称可选，默认 `cipher-ref:<uuid>`，≤ 128 字符。

## MVP 边界

- **TTL 执行**：`expires_at` 已落库并建索引，且**列表读取已过滤过期项**（`expires_at is null or expires_at > now()`）。但「worker 加载链路到期拒绝使用」的检查尚未接入——worker 读取 `morpheus_encrypted_secrets` 时仍需加同样的过滤，属执行接线里程碑。
- **运行时 `getSecret()`**：TEE worker 内的 `getSecret(name)` 注入（对齐 CRE `runtime.getSecret()`）尚未实现；当前 secret 仍通过链上 `encrypted_params_ref` 由 worker 解密注入。
- 数据层见 migration `0018_secret_rotation.sql`（`expires_at` 列 + update/delete RLS）。
