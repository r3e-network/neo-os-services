# NeoDID DID Method

This document defines the public W3C DID method exposed by Morpheus NeoDID.

本文定义 Morpheus NeoDID 对外暴露的 W3C DID method。

Current production architecture:

- DID resolution is public and stays outside the TEE
- bind / ticket issuance stays on the Oracle request/response path
- the Oracle CVM executes private verification work for both mainnet and testnet
- the DataFeed CVM is unrelated to DID issuance and remains isolated for market-data publication

## 1. Scope / 范围

The DID method is intended for:

- public service discovery
- publishing the current NeoDID verifier key in W3C DID form
- exposing stable subject namespaces for Neo vault accounts and AA recovery identities
- giving integrators one standard entrypoint for resolver-based interoperability

这个 DID method 用于：

- 公开服务发现
- 以 W3C DID 的形式发布当前 NeoDID verifier key
- 为 Neo vault 账户和 AA 恢复身份暴露稳定的 subject namespace
- 给集成方提供统一的 resolver 入口

It is **not** intended to publish private claims.

它**不是**用来公开私密 claim 的。

The following private materials never appear in DID resolution output:

- provider UID
- Web3Auth JWT claims
- master nullifier
- action nullifier
- encrypted params / encrypted payload
- recovery ticket payload

以下私密材料不会出现在 DID 解析结果中：

- provider UID
- Web3Auth JWT claims
- master nullifier
- action nullifier
- encrypted params / encrypted payload
- recovery ticket payload

## 2. Method Name / 方法名

- DID method name: `morpheus`
- Current supported network segment: `neo_n3`

Examples:

- `did:morpheus:neo_n3:service:neodid`
- `did:morpheus:neo_n3:vault:6d0656f6dd91469db1c90cc1e574380613f43738`
- `did:morpheus:neo_n3:aa:<aa-account-id>`

示例：

- `did:morpheus:neo_n3:service:neodid`
- `did:morpheus:neo_n3:vault:6d0656f6dd91469db1c90cc1e574380613f43738`
- `did:morpheus:neo_n3:aa:<aa-account-id>`

## 3. Subject Types / Subject 类型

### 3.1 Service DID

`did:morpheus:neo_n3:service:neodid`

Purpose:

- publish NeoDID service metadata
- publish the current TEE verifier key as `JsonWebKey2020`
- anchor Oracle / Registry / Runtime endpoints

作用：

- 发布 NeoDID 服务元数据
- 以 `JsonWebKey2020` 形式发布当前 TEE verifier key
- 锚定 Oracle / Registry / Runtime 端点

### 3.2 Vault DID

`did:morpheus:neo_n3:vault:<hash160>`

Purpose:

- represent a Neo N3 vault namespace
- publish which Morpheus service is authoritative for privacy-preserving bindings
- provide resolver and registry hints without revealing the bound social identity

作用：

- 表示一个 Neo N3 vault namespace
- 表示哪一个 Morpheus 服务对隐私绑定具有权威性
- 提供 resolver 和 registry 提示，但不泄露绑定的社交身份

### 3.3 AA DID

`did:morpheus:neo_n3:aa:<account-id>`

Purpose:

- represent an Abstract Account recovery namespace
- publish the recovery verifier integration surface
- connect AA recovery flows to NeoDID-issued tickets

作用：

- 表示一个抽象账户恢复 namespace
- 发布恢复验证器的集成入口
- 把 AA 恢复流程和 NeoDID 签发的票据连接起来

## 4. Resolution Endpoint / 解析接口

Public web resolver:

- `GET /api/neodid/resolve?did=<did>`

Optional document-only output:

- `GET /api/neodid/resolve?did=<did>&format=document`
- or `Accept: application/did+ld+json`

公开 Web resolver：

- `GET /api/neodid/resolve?did=<did>`

只返回 DID document 的方式：

- `GET /api/neodid/resolve?did=<did>&format=document`
- 或设置 `Accept: application/did+ld+json`

Default response content type:

- `application/ld+json;profile="https://w3id.org/did-resolution"`

Document response content type:

- `application/did+ld+json`

## 5. W3C Alignment / 与 W3C DID 规范的对应

The resolver returns a standard DID Resolution object:

- `didResolutionMetadata`
- `didDocument`
- `didDocumentMetadata`

解析器返回标准 DID Resolution object：

- `didResolutionMetadata`
- `didDocument`
- `didDocumentMetadata`

The DID document uses:

- `@context = https://www.w3.org/ns/did/v1`
- `JsonWebKey2020` for the NeoDID verifier key
- service endpoints for registry, Oracle gateway, runtime, and AA recovery integration

DID document 使用：

- `@context = https://www.w3.org/ns/did/v1`
- 使用 `JsonWebKey2020` 表达 NeoDID verifier key
- 用 service endpoints 表达 registry、Oracle gateway、runtime、AA recovery 集成面

## 6. Privacy Model / 隐私模型

NeoDID intentionally separates:

1. public resolver metadata
2. private identity verification
3. private Oracle payloads
4. unlinkable ticket consumption

NeoDID 有意把下面四层隔离开：

1. 公开 resolver 元数据
2. 私密身份验证
3. 私密 Oracle payload
4. 不可关联的 ticket 消费

This means a DID resolver consumer can discover:

- which contract is authoritative
- which public verifier key is current
- which request types are supported
- where to obtain runtime metadata

But the consumer cannot learn:

- which social account is bound
- what encrypted parameter was submitted
- whether two different action tickets belong to the same user

这意味着 resolver 使用方可以知道：

- 哪个合约是权威锚点
- 当前的 public verifier key 是什么
- 支持哪些 request type
- 去哪里获取 runtime metadata

但不能知道：

- 绑定的是哪个社交账号
- 用户提交了什么加密参数
- 两个不同 action ticket 是否属于同一用户

## 7. Oracle Relationship / 与 Oracle 的关系

NeoDID resolution is public.

NeoDID issuance is not public.

Production bind / ticket issuance still enters through the existing Oracle flow:

- `neodid_bind`
- `neodid_action_ticket`
- `neodid_recovery_ticket`

NeoDID 的解析层是公开的。

NeoDID 的签发层不是公开直接调用的。

生产环境下的 bind / ticket issuance 仍然通过现有 Oracle 流程进入：

- `neodid_bind`
- `neodid_action_ticket`
- `neodid_recovery_ticket`

## 8. Web3Auth Relationship / 与 Web3Auth 的关系

For `provider = "web3auth"`:

- the frontend obtains `id_token`
- the token can be encrypted locally with the Oracle X25519 public key
- the worker verifies the JWT against JWKS inside the TEE
- the stable provider root is derived inside the TEE

对于 `provider = "web3auth"`：

- 前端获取 `id_token`
- token 可以先用 Oracle X25519 公钥在本地加密
- worker 在 TEE 内使用 JWKS 校验 JWT
- 稳定 provider root 在 TEE 内部导出

The DID resolver does not return the JWT or the derived root.

DID resolver 不返回 JWT，也不返回导出的 root。

## 9. AA Recovery Relationship / 与 AA 恢复的关系

AA recovery verifiers should treat:

- `did:morpheus:neo_n3:aa:<account-id>`

as the public namespace for recovery authorization,
while the actual recovery approval still comes from a NeoDID recovery ticket.

AA 恢复验证器应把：

- `did:morpheus:neo_n3:aa:<account-id>`

视为恢复授权的公开 namespace，
但真正的恢复授权仍由 NeoDID recovery ticket 提供。

## 10. Example / 示例

```bash
curl "https://oracle.meshmini.app/mainnet/neodid/resolve?did=did:morpheus:neo_n3:service:neodid"
```

```bash
curl "https://oracle.meshmini.app/mainnet/neodid/resolve?did=did:morpheus:neo_n3:aa:<aa-account-id>&format=document"
```

## 11. Implementation Notes / 实现说明

- The resolver is a web-layer view over the current Morpheus deployment.
- The service DID includes the live verifier public key when runtime metadata is available.
- Vault and AA DIDs are namespace descriptors, not claim disclosures.
- The authoritative on-chain anchors remain the Neo N3 contracts and NeoNS names.

- resolver 是对当前 Morpheus 部署的一个 Web 层视图。
- 当 runtime metadata 可用时，service DID 会包含实时 verifier public key。
- Vault DID 和 AA DID 是 namespace 描述，不是 claim 披露。
- 真正的权威锚点仍然是 Neo N3 合约和 NeoNS 域名。
