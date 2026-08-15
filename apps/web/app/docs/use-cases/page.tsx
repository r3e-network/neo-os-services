import Link from 'next/link';
import {
  Shield,
  Lock,
  Zap,
  FileCode,
  Database,
  Calculator,
  Activity,
  Terminal,
  Globe,
} from 'lucide-react';
import { NETWORKS } from '@/lib/onchain-data';

const oracleProviders = [
  {
    name: 'twelvedata',
    kind: 'Built-in',
    note: 'Production default for market / FX / commodity / equity / ETF quotes.',
    example: {
      provider: 'twelvedata',
      symbol: 'NEO-USD',
      json_path: 'price',
      target_chain: 'neo_n3',
    },
  },
  {
    name: 'binance-spot',
    kind: 'Built-in',
    note: 'Good for direct crypto spot reads in custom Oracle flows.',
    example: {
      provider: 'binance-spot',
      symbol: 'BTC-USD',
      target_chain: 'neo_n3',
    },
  },
  {
    name: 'coinbase-spot',
    kind: 'Built-in',
    note: 'Useful when you want Coinbase spot references in a callback flow.',
    example: {
      provider: 'coinbase-spot',
      symbol: 'ETH-USD',
      target_chain: 'neo_n3',
    },
  },
  {
    name: 'custom URL',
    kind: 'User supplied',
    note: 'Any REST API. Combine with encrypted headers, encrypted token, custom JS, or WASM.',
    example: {
      url: '<production-api-url>',
      json_path: '<json-path>',
      target_chain: 'neo_n3',
    },
  },
];

const oracleScenarios = [
  {
    icon: Shield,
    title: 'Private Premium API Access',
    problem:
      'You need paid API data, but you cannot leak the API key to node operators or contract logs.',
    solution:
      'Fetch the Oracle public key, encrypt the token or headers, then send the request through the Oracle contract. The key is only unsealed inside the TEE.',
    payload: `{
 "url": "https://api.example.com/private-price",
 "method": "GET",
 "encrypted_token": "<sealed bearer token>",
 "token_header": "Authorization",
 "json_path": "price",
 "target_chain": "neo_n3"
}`,
  },
  {
    icon: Activity,
    title: 'Return Only A Boolean',
    problem:
      'You want to check a sensitive off-chain condition, but you do not want the raw profile / account data to ever appear on-chain.',
    solution:
      'Send encrypted credentials plus a tiny custom reduction function. The worker fetches the data, evaluates the condition inside the enclave, and returns only `true/false`.',
    payload: `{
 "url": "https://api.example.com/private-profile",
 "encrypted_params": "<sealed auth headers and script>",
 "script": "function process(data) { return data.followers > 10000; }",
 "entry_point": "process",
 "target_chain": "neo_n3"
}`,
  },
  {
    icon: FileCode,
    title: 'Built-in Provider + Confidential Params',
    problem:
      'You want the convenience of a built-in provider, but you still need to hide fields like `json_path`, provider params, or function name.',
    solution:
      'Use `encrypted_payload` or `encrypted_params` to patch the request inside the TEE before the built-in provider call executes.',
    payload: `{
 "symbol": "TWELVEDATA:BTC-USD",
 "encrypted_payload": "<sealed { \\"json_path\\": \\"price\\", \\"target_chain\\": \\"neo_n3\\" }>"
}`,
  },
  {
    icon: Database,
    title: 'Custom Reduction On Public Data',
    problem:
      'The upstream API is public, but you want a custom transformed output instead of forwarding the raw response.',
    solution:
      'Use a normal Oracle request with custom JS or WASM to reduce the response into the exact scalar your contract wants.',
    payload: `{
 "symbol": "TWELVEDATA:SOL-USD",
 "script": "function process(data) { return Number(data.price) > 100; }",
 "entry_point": "process",
 "target_chain": "neo_n3"
}`,
  },
];

const builtinScenarios = [
  {
    icon: Lock,
    title: 'privacy.mask',
    summary: 'Mask sensitive strings before returning them.',
    payload: `{
 "mode": "builtin",
 "function": "privacy.mask",
 "input": { "value": "13812345678", "unmasked_left": 3, "unmasked_right": 4 },
 "target_chain": "neo_n3"
}`,
  },
  {
    icon: Calculator,
    title: 'math.modexp',
    summary:
      'Useful for big integer cryptography, RSA helpers, VDF-style workloads, and challenge-response math.',
    payload: `{
 "mode": "builtin",
 "function": "math.modexp",
 "input": { "base": "123456789", "exponent": "987654321", "modulus": "2147483647" },
 "target_chain": "neo_n3"
}`,
  },
  {
    icon: Activity,
    title: 'vector.cosine_similarity',
    summary: 'Compare embeddings or user vectors without deploying your own script runtime.',
    payload: `{
 "mode": "builtin",
 "function": "vector.cosine_similarity",
 "input": { "left": [0.12, 0.91, 0.33], "right": [0.15, 0.87, 0.31] },
 "target_chain": "neo_n3"
}`,
  },
  {
    icon: Database,
    title: 'zkp.public_signal_hash',
    summary:
      'Hash large public-signal arrays off-chain and return one digest for cheap contract verification.',
    payload: `{
 "mode": "builtin",
 "function": "zkp.public_signal_hash",
 "input": { "circuit_id": "credit_v1", "signals": ["1", "2", "3"] },
 "target_chain": "neo_n3"
}`,
  },
  {
    icon: Zap,
    title: 'fhe.noise_budget_estimate',
    summary:
      'Plan FHE workloads before you commit to expensive proving or encrypted inference pipelines.',
    payload: `{
 "mode": "builtin",
 "function": "fhe.noise_budget_estimate",
 "input": { "multiplicative_depth": 4, "scale_bits": 40, "modulus_bits": 218 },
 "target_chain": "neo_n3"
}`,
  },
  {
    icon: FileCode,
    title: 'hash.sha256 / hash.keccak256 / merkle.root',
    summary:
      'Good for proof preprocessing, settlement digests, commitment schemes, and callback minimization.',
    payload: `{
 "mode": "builtin",
 "function": "merkle.root",
 "input": { "leaves": ["a", "b", "c"] },
 "target_chain": "neo_n3"
}`,
  },
];

const participationFlow = [
  '1. 打开 Dashboard 或前端文档页，先获取 Oracle public key。',
  '2. 如果有敏感参数，用 X25519-HKDF-SHA256-AES-256-GCM 本地加密成 `encrypted_payload` / `encrypted_params` / `encrypted_token`。',
  '3. 选择最短路径：Builtin Provider、Custom URL、Builtin Compute、Custom JS、WASM。',
  '4. 通过 NeoOS Oracle（链上兼容名 MorpheusOracle）合约提交请求，而不是直接依赖链外接口。',
  '5. 用 callback 或通用测试 Consumer 读取结果，并检查 `verification.output_hash / attestation_hash / tee_attestation`。',
];

export default function DocsUseCases() {
  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <Zap size={14} color="var(--neo-green)" />
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 800,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0,
            fontFamily: 'var(--font-mono)',
          }}
        >
          SOLUTIONS & DIRECT STARTERS
        </span>
      </div>
      <h1>Use Cases</h1>

      <p
        className="lead"
        style={{
          fontSize: '1.1rem',
          color: 'var(--text-primary)',
          marginBottom: '2.5rem',
          lineHeight: 1.6,
        }}
      >
        This page focuses on <strong>directly usable</strong> Privacy Oracle and Privacy Compute
        patterns. The goal is simple: users should be able to pick a data source or built-in
        function, copy a payload, encrypt sensitive fields if needed, and start using Morpheus
        without first learning a custom runtime.
      </p>

      <div
        className="card-industrial"
        style={{
          padding: '2rem',
          borderLeft: '4px solid var(--neo-green)',
          marginBottom: '2.5rem',
        }}
      >
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
          <Terminal size={20} color="var(--neo-green)" />
          <h3
            style={{
              margin: 0,
              fontSize: '1rem',
              fontWeight: 800,
              color: 'var(--text-primary)',
              textTransform: 'uppercase',
              letterSpacing: 0,
            }}
          >
            How Users Participate
          </h3>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {participationFlow.map((step) => (
            <div key={step} style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              {step}
            </div>
          ))}
        </div>
        <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Link
            href="/docs/templates"
            className="btn btn-secondary btn-sm"
            style={{ textDecoration: 'none' }}
          >
            Open Starter Templates
          </Link>
          <Link
            href="/docs/studio"
            className="btn btn-secondary btn-sm"
            style={{ textDecoration: 'none' }}
          >
            Open Starter Studio
          </Link>
        </div>
      </div>

      <h2>1. Built-in Data Sources</h2>
      <p>
        For Privacy Oracle, the easiest starting point is to use a built-in source. These are
        already integrated into the worker and can be mixed with encrypted params, custom JS, or
        callback-based contract fulfillment.
      </p>

      <div
        style={{
          overflowX: 'auto',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-sm)',
          background: 'var(--bg-panel)',
          margin: '2rem 0 3rem',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid var(--border-dim)',
                background: 'rgba(83, 58, 253, 0.045)',
              }}
            >
              <th style={{ padding: '0.9rem 1rem', textAlign: 'left' }}>Source</th>
              <th style={{ padding: '0.9rem 1rem', textAlign: 'left' }}>Type</th>
              <th style={{ padding: '0.9rem 1rem', textAlign: 'left' }}>When To Use</th>
              <th style={{ padding: '0.9rem 1rem', textAlign: 'left' }}>Starter Payload</th>
            </tr>
          </thead>
          <tbody>
            {oracleProviders.map((item) => (
              <tr key={item.name} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                <td
                  style={{
                    padding: '0.85rem 1rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {item.name}
                </td>
                <td style={{ padding: '0.85rem 1rem', color: 'var(--text-secondary)' }}>
                  {item.kind}
                </td>
                <td style={{ padding: '0.85rem 1rem', color: 'var(--text-secondary)' }}>
                  {item.note}
                </td>
                <td
                  style={{
                    padding: '0.85rem 1rem',
                    color: 'var(--accent-blue)',
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {JSON.stringify(item.example, null, 2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>2. Privacy Oracle Ready Cases</h2>
      <p>
        These are the fastest paths for users who want to participate immediately through the Oracle
        contract and callback model.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1.5rem',
          margin: '2rem 0 3rem',
        }}
      >
        {oracleScenarios.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.title}
              style={{
                padding: '2rem',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-dim)',
                borderRadius: 'var(--ns-radius-lg)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '1rem' }}
              >
                <div
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: 'var(--ns-radius-md)',
                    background: 'var(--neo-green-dim)',
                    border: '1px solid rgba(22, 199, 132, 0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon size={20} color="var(--neo-green)" />
                </div>
                <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800 }}>{item.title}</h3>
              </div>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '1rem' }}>
                <strong style={{ color: 'var(--text-primary)' }}>Problem:</strong> {item.problem}
              </p>
              <p
                style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '1.25rem' }}
              >
                <strong style={{ color: 'var(--text-primary)' }}>Direct path:</strong>{' '}
                {item.solution}
              </p>
              <div
                style={{
                  padding: '1rem',
                  background: 'rgba(83, 58, 253, 0.045)',
                  border: '1px solid var(--border-dim)',
                  borderRadius: 'var(--ns-radius-sm)',
                  marginTop: 'auto',
                }}
              >
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: 'var(--text-secondary)',
                    fontWeight: 800,
                    marginBottom: '0.5rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  STARTER PAYLOAD
                </div>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    color: 'var(--accent-blue)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8rem',
                  }}
                >
                  {item.payload}
                </pre>
              </div>
            </div>
          );
        })}
      </div>

      <h2>3. Built-in Compute Ready Cases</h2>
      <p>
        If the user does not need an external data fetch and only needs secure off-chain
        computation, use <code>mode = "builtin"</code>. These methods are already shipped in the
        worker and do not require user-supplied scripts.
      </p>

      <div
        style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', margin: '2rem 0 3rem' }}
      >
        {builtinScenarios.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.title}
              style={{
                padding: '1.75rem',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-dim)',
                borderRadius: 'var(--ns-radius-lg)',
                borderLeft: '4px solid var(--neo-green)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  marginBottom: '0.85rem',
                }}
              >
                <Icon size={18} color="var(--neo-green)" />
                <h3
                  style={{
                    margin: 0,
                    fontSize: '1rem',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: 0,
                  }}
                >
                  {item.title}
                </h3>
              </div>
              <p
                style={{
                  marginTop: 0,
                  marginBottom: '1rem',
                  color: 'var(--text-secondary)',
                  lineHeight: 1.6,
                }}
              >
                {item.summary}
              </p>
              <div
                style={{
                  padding: '1rem',
                  background: 'rgba(83, 58, 253, 0.045)',
                  border: '1px solid var(--border-dim)',
                  borderRadius: 'var(--ns-radius-sm)',
                }}
              >
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: 'var(--text-secondary)',
                    fontWeight: 800,
                    marginBottom: '0.5rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  STARTER PAYLOAD
                </div>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    color: 'var(--accent-blue)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8rem',
                  }}
                >
                  {item.payload}
                </pre>
              </div>
            </div>
          );
        })}
      </div>

      <h2>4. Best First Steps For New Users</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '1.5rem',
          margin: '2rem 0',
        }}
      >
        <div className="card-industrial" style={{ padding: '1.75rem' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '0.85rem' }}
          >
            <Globe size={18} color="var(--neo-green)" />
            <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 800 }}>
              Zero-Code Oracle Test
            </h3>
          </div>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 0 }}>
            Use the universal callback consumer on {NETWORKS.neo_n3.name}, submit a built-in
            provider request, and inspect the callback result without deploying your own contract
            first.
          </p>
        </div>
        <div className="card-industrial" style={{ padding: '1.75rem' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '0.85rem' }}
          >
            <Lock size={18} color="var(--neo-green)" />
            <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 800 }}>
              Encrypted Built-in Compute
            </h3>
          </div>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 0 }}>
            Keep the function name and input private by sealing a full JSON patch into{' '}
            <code>encrypted_payload</code>, then let the TEE resolve and execute it.
          </p>
        </div>
        <div className="card-industrial" style={{ padding: '1.75rem' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '0.85rem' }}
          >
            <FileCode size={18} color="var(--neo-green)" />
            <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 800 }}>
              Custom URL + Tiny JS
            </h3>
          </div>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 0 }}>
            Start with a public URL, then add a tiny reduction function that returns a scalar or
            boolean. This is the easiest path from “public fetch” to “TEE logic”.
          </p>
        </div>
      </div>
    </div>
  );
}
