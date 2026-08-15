# Technology Stack

**Analysis Date:** 2026-07-04

## Languages

**Primary:**

- TypeScript/JavaScript (Node.js 22) — All application, worker, package, script, and Cloudflare worker code
- C# (.NET 10) — Neo N3 smart contracts in `contracts/`
- Solidity 0.8.24 — EVM/Neo X mirror contracts in `contracts-evm/`
- Go 1.22 — AWS Nitro NSM attestation helper in `deploy/nitro/nsm-attest/`
- SQL — Supabase migrations in `supabase/migrations/`

**Secondary:**

- Bash — Build scripts, deployment helpers, and CI glue (`contracts/build.sh`, `scripts/*.sh`, `deploy/nitro/*.sh`)
- Markdown — Documentation and runbooks

## Runtime

**Environment:**

- Node.js 22.x (LTS) — Used by CI (`node-version: 22`), Docker images (`node:22-alpine`), and local development
- Docker / Docker Compose — Used for local worker runs and Nitro enclave packaging
- AWS Nitro Enclaves — Confidential execution plane for the oracle runtime and datafeed signer

**Package Manager:**

- npm 10.x (inferred from Node 22)
- Lockfile: `package-lock.json` present and enforced in CI (`npm install --package-lock-only`, `git diff --exit-code`)
- npm workspaces: `apps/*`, `workers/*`, `packages/*` defined in root `package.json`

## Frameworks

**Core:**

- Next.js 15.5.18 (`apps/web/package.json`) — Web dashboard, docs, explorer, and API routes
- React 18.3.1 (`apps/web/package.json`) — UI framework
- Neo.SmartContract.Framework 3.9.1 (`contracts/Directory.Build.props`) — Neo N3 smart contract SDK
- Foundry (`contracts-evm/foundry.toml`) — EVM contract build/test harness (solc 0.8.24, evm_version paris, optimizer 200 runs)

**Testing:**

- Vitest 4.1.4 (`apps/web/package.json`) — Web app unit tests
- Node.js built-in `node --test` — Worker, package, script, and deploy tests
- dotnet test (`contracts/__tests__/NeoContracts.Tests.csproj`) — Neo N3 contract tests
- Foundry/Solidity inline tests (`contracts-evm/test/MorpheusOracleEVM.t.sol`) — EVM contract tests

**Build/Dev:**

- TypeScript 5.8.2 (`apps/web/package.json`) — Type checking for the web app
- ESLint 8.57.0 with `@typescript-eslint` 8.57.1 — Linting for `js,mjs,ts,tsx`
- Prettier 3.3.0 — Formatting for `js,mjs,ts,tsx,json,md,yml,yaml`
- solc 0.8.24 (`package.json` devDependencies) — Solidity compiler used by scripts
- Neo.Compiler.CSharp (nccs) 3.9.1 (`contracts/build.sh`, CI) — Neo N3 contract compiler

## Key Dependencies

**Critical:**

- `@cityofzion/neon-js` 5.8.1 — Neo N3 RPC, wallet, transaction, and smart-contract invocation. Used everywhere Neo N3 is touched (`workers/nitro-worker/src/chain/neo-n3.js`, `workers/morpheus-relayer/src/neo-n3.js`, `deploy/feed-pusher/feed-pusher.mjs`).
- `ethers` 6.16.0 — EVM/Neo X wallet, contract, and provider interactions (`workers/nitro-worker/package.json`, `workers/morpheus-relayer/package.json`, root `package.json`).
- `@supabase/supabase-js` 2.89.0 — Server/client Supabase access (`apps/web/lib/server-supabase.ts`, `workers/nitro-worker/src/platform/core.js`).
- `@sentry/nextjs` 10.49.0 — Error tracking and performance for the Next.js app (`apps/web/next.config.mjs`, `apps/web/sentry.*.config.ts`).
- `jose` 6.2.1 — JWT/JWKS parsing and validation in the Nitro worker (`workers/nitro-worker/package.json`).
- `undici` 8.5.0 — HTTP client used in the Nitro worker (`workers/nitro-worker/package.json`).
- `@aws-sdk/client-secrets-manager` 3.0.0 — AWS Secrets Manager integration in the Nitro worker (`workers/nitro-worker/package.json`).

**Infrastructure/UI:**

- `next` 15.5.18 — Web framework
- `react` / `react-dom` 18.3.1 — UI
- `lucide-react` 0.577.0 — Icons
- `react-markdown` 10.1.0, `remark-gfm` 4.0.1, `rehype-raw` 7.0.0, `rehype-slug` 6.0.0, `github-slugger` 2.0.0, `gray-matter` 4.0.3, `highlight.js` 11.11.1 — Docs/rendering

**Blockchain Tooling:**

- `solc` 0.8.24 — Solidity compiler
- `Neo.SmartContract.Framework` 3.9.1 — Neo N3 contract framework
- `Neo.Compiler.CSharp` 3.9.1 — Neo N3 compiler

## Configuration

**Environment:**

- `.env` files at repository root: `.env.example`, `.env.development.example`, `.env.production.example`
- Required vars differ by environment; see `docs/ENVIRONMENT.md` for bilingual explanations
- Key vars: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEO_RPC_URL`, `NEO_NETWORK_MAGIC`, `MORPHEUS_RUNTIME_TOKEN`, `TWELVEDATA_API_KEY`, `CONTRACT_MORPHEUS_ORACLE_HASH`, etc.
- Per-component env examples: `deploy/nitro/morpheus.env.example`, `deploy/nitro/nitro-worker.env.example`, `deploy/feed-pusher/feed-pusher.env.example`

**Build:**

- `apps/web/tsconfig.json` — Next.js TypeScript config (target ES2022, module esnext, bundler resolution)
- `apps/web/next.config.mjs` — Next.js config with Sentry, security headers, image formats
- `contracts/Directory.Build.props` — .NET 10 + Neo.SmartContract.Framework defaults
- `contracts-evm/foundry.toml` — Foundry profile for Neo X mirror contracts
- `.eslintrc.json` — ESLint configuration
- `.prettierrc` — Prettier configuration

## Platform Requirements

**Development:**

- macOS/Linux/Windows with Node.js 22
- .NET 10 SDK for Neo contract builds
- Neo.Compiler.CSharp 3.9.1 (`nccs`) for Neo contract compilation
- Docker for local Nitro worker / relayer images and enclave simulation
- Go 1.22 only required inside the Nitro EIF build stage (not on the host)

**Production:**

- Web app: Vercel (`deploy-web.yml` workflow, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`)
- Cloudflare Workers: edge gateway (`deploy/cloudflare/morpheus-edge-gateway`) and control plane (`deploy/cloudflare/morpheus-control-plane`) with Cloudflare Queues and Workflows
- AWS Nitro Enclaves: confidential execution plane (`deploy/nitro/`)
- Docker images: published to GitHub Container Registry (`ghcr.io`) via `publish-images.yml` (`workers/nitro-worker`, `workers/morpheus-relayer`)
- GitHub Actions CI/CD: `.github/workflows/ci.yml`, `deploy-web.yml`, `publish-images.yml`

---

_Stack analysis: 2026-07-04_
_Update after major dependency changes_
