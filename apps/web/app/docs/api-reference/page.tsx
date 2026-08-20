import { Code2 } from 'lucide-react';
import { BUILTIN_FUNCTIONS } from '@/lib/docs-data';
import { NETWORKS } from '@/lib/onchain-data';
import { CodeBlock } from '@/components/ui/CodeBlock';

// Public HTTP edge surface served by the Vercel app. Each row mirrors the
// values declared in the matching route handler (scope / maxRequests / window)
// so this table cannot silently drift from the enforced limits.
const PUBLIC_HTTP_ROUTES = [
  {
    method: 'POST',
    path: '/api/oracle/query',
    rateLimit: '30 / minute / IP',
    desc: 'Off-chain provider fetch + TEE-signed result preview (provider-aware payload resolution).',
  },
  {
    method: 'POST',
    path: '/api/oracle/smart-fetch',
    rateLimit: '20 / minute / IP',
    desc: 'Heuristic provider selection variant of /api/oracle/query.',
  },
  {
    method: 'POST',
    path: '/api/compute/execute',
    rateLimit: '20 / minute / IP',
    desc: 'Run a builtin or custom-JS compute function inside the enclave. Requires target_chain to be neo_n3 when supplied.',
  },
  {
    method: 'GET',
    path: '/api/feeds/[symbol]',
    rateLimit: 'unmetered (read)',
    desc: 'Latest price quote for a symbol. Accepts ?provider, ?project_slug, ?provider_params (URL-encoded JSON).',
  },
];

export default function DocsApiReference() {
  const oracleDomain = NETWORKS.neo_n3.domains.oracle || 'unassigned';

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <Code2 size={14} color="var(--neo-green)" />
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
          DEVELOPER REFERENCE
        </span>
      </div>
      <h1>API Reference</h1>

      <p
        className="lead"
        style={{ fontSize: '1.15rem', color: 'var(--text-primary)', marginBottom: '2.5rem' }}
      >
        Complete technical specifications for the Morpheus smart contracts and the Enclave
        Javascript SDK.
      </p>

      <h2>1. Smart Contract Interface (Neo N3 C#)</h2>
      <p>The active on-chain interface is the Neo N3 C# call pattern below.</p>

      <div
        style={{
          padding: '0',
          overflow: 'hidden',
          marginBottom: '2.5rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-sm)',
        }}
      >
        <div
          style={{
            padding: '1rem 1.5rem',
            borderBottom: '1px solid var(--border-dim)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 800,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-primary)',
              textTransform: 'uppercase',
              letterSpacing: 0,
            }}
          >
            Oracle Call Pattern
          </span>
        </div>
        <div style={{ padding: '1.5rem', background: 'var(--bg-code)', overflowX: 'auto' }}>
          <pre style={{ margin: 0, border: 'none', background: 'transparent' }}>
            <code
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                lineHeight: 1.6,
                color: 'var(--text-primary)',
              }}
            >{`// ${NETWORKS.neo_n3.name} Oracle: ${NETWORKS.neo_n3.oracle}

string payloadJson = "{\"symbol\":\"TWELVEDATA:NEO-USD\",\"json_path\":\"price\",\"target_chain\":\"neo_n3\"}";

Contract.Call(
 MorpheusOracleHash,
 "request",
 CallFlags.All,
 "privacy_oracle",
 (ByteString)payloadJson,
 Runtime.ExecutingScriptHash,
 "onOracleResult"
);`}</code>
          </pre>
        </div>
      </div>

      <p>
        To interact with NeoOS Oracle (deployed as MorpheusOracle) on {NETWORKS.neo_n3.name}, use{' '}
        <code>Contract.Call</code> against <code>{NETWORKS.neo_n3.oracle}</code> or NeoNS{' '}
        <code>{oracleDomain}</code>.
      </p>

      <h2>2. NeoDID Resolution</h2>
      <p>
        NeoDID now also exposes a W3C DID resolution route for public service discovery and subject
        namespaces:
      </p>

      <div
        style={{
          padding: '0',
          overflow: 'hidden',
          marginBottom: '2.5rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-sm)',
        }}
      >
        <div
          style={{
            padding: '1rem 1.5rem',
            borderBottom: '1px solid var(--border-dim)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 800,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-primary)',
              textTransform: 'uppercase',
              letterSpacing: 0,
            }}
          >
            GET /api/neodid/resolve
          </span>
        </div>
        <div style={{ padding: '1.5rem', background: 'var(--bg-code)', overflowX: 'auto' }}>
          <pre style={{ margin: 0, border: 'none', background: 'transparent' }}>
            <code
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                lineHeight: 1.6,
                color: 'var(--text-primary)',
              }}
            >{`GET /api/neodid/resolve?did=did:morpheus:neo_n3:service:neodid
Accept: application/ld+json;profile="https://w3id.org/did-resolution"

GET /api/neodid/resolve?did=did:morpheus:neo_n3:vault:6d0656f6dd91469db1c90cc1e574380613f43738&format=document
Accept: application/did+ld+json`}</code>
          </pre>
        </div>
      </div>

      <p>
        The resolver exposes the public service DID document, TEE verifier JWK, registry anchors,
        and subject namespaces without leaking provider UIDs or nullifiers.
      </p>

      <h2>3. Enclave SDK (Javascript)</h2>
      <p>
        When using built-in compute, Morpheus exposes a fixed catalog of functions. Custom JS
        compute receives <code>input</code> and <code>helpers</code>; Oracle custom JS receives{' '}
        <code>data</code>, <code>context</code>, and <code>helpers</code>.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '1.5rem',
        }}
      >
        {BUILTIN_FUNCTIONS.map((fn) => (
          <div
            key={fn.name}
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              borderRadius: 'var(--ns-radius-lg)',
              padding: '1.5rem',
              borderTop: '3px solid var(--accent-purple)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: '0.75rem',
                alignItems: 'flex-start',
              }}
            >
              <code
                style={{
                  color: 'var(--neo-green)',
                  fontWeight: 800,
                  fontSize: '0.95rem',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {fn.name}
              </code>
              <span
                className="badge-outline"
                style={{
                  color: 'var(--accent-purple)',
                  fontSize: '0.55rem',
                  padding: '0.2rem 0.5rem',
                  borderColor: 'var(--accent-purple)',
                  textTransform: 'uppercase',
                }}
              >
                {fn.category}
              </span>
            </div>
            <p
              style={{
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
                marginBottom: '1.5rem',
                lineHeight: 1.6,
              }}
            >
              {fn.desc}
            </p>
            <div
              style={{
                background: 'var(--bg-code)',
                padding: '1rem',
                borderRadius: 'var(--ns-radius-sm)',
                border: '1px solid var(--border-dim)',
              }}
            >
              <div
                style={{
                  fontSize: '0.65rem',
                  color: 'var(--text-muted)',
                  marginBottom: '0.5rem',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: 0,
                }}
              >
                // PARAMETERS
              </div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-primary)',
                  marginBottom: '1.5rem',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {fn.params}
              </div>

              <div
                style={{
                  fontSize: '0.65rem',
                  color: 'var(--text-muted)',
                  marginBottom: '0.5rem',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: 0,
                }}
              >
                // EXAMPLE
              </div>
              <code
                style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  color: 'var(--text-primary)',
                  wordBreak: 'break-all',
                  fontFamily: 'var(--font-mono)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {fn.example}
              </code>
            </div>
          </div>
        ))}
      </div>

      <h2>4. Public HTTP API</h2>
      <p>
        The Vercel edge app exposes a small set of public JSON endpoints in front of the enclave.
        All bodies are JSON. POST routes are IP rate-limited; on overflow they return{' '}
        <code>429</code> with <code>{`{ error: "Too many requests", retryAfter }`}</code>. Every
        rate-limited response carries <code>X-RateLimit-Limit</code>,{' '}
        <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code> (ISO-8601), and{' '}
        <code>Retry-After</code> (seconds) headers.
      </p>

      <div style={{ overflowX: 'auto', margin: '1.5rem 0' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.8rem',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-dim)' }}>
              <th style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Method</th>
              <th style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Path</th>
              <th style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Rate limit</th>
              <th style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Description</th>
            </tr>
          </thead>
          <tbody>
            {PUBLIC_HTTP_ROUTES.map((route) => (
              <tr
                key={route.path}
                style={{ borderBottom: '1px solid var(--border-dim)', verticalAlign: 'top' }}
              >
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--accent-purple)' }}>
                  {route.method}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--neo-green)' }}>
                  {route.path}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-secondary)' }}>
                  {route.rateLimit}
                </td>
                <td
                  style={{
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  {route.desc}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Degraded / fallback shapes</h3>
      <p>
        When an upstream provider is unavailable, <code>GET /api/feeds/[symbol]</code> responds with
        HTTP <code>200</code> and a degraded envelope (so callers can distinguish &quot;no
        quote&quot; from a request error). The upstream status is also surfaced in the{' '}
        <code>x-morpheus-upstream-status</code> header. Invalid input returns HTTP <code>400</code>{' '}
        with <code>{`{ error: "..." }`}</code>.
      </p>

      <CodeBlock
        language="json"
        title="GET /api/feeds/NEO-USD (degraded)"
        code={`{
  "status": "unavailable",
  "degraded": true,
  "symbol": "NEO-USD",
  "provider": "twelvedata",
  "error": "feed_quote_unavailable",
  "upstream_status": 503
}`}
      />

      <h3>Staleness</h3>
      <p>
        A successful response carries <code>age_seconds</code> and <code>stale_after_seconds</code>{' '}
        so a caller can apply its own, tighter budget. When the on-chain record is older than its
        budget the route returns <code>status: &quot;stale&quot;</code> with{' '}
        <code>cache-control: no-store</code> and <code>x-morpheus-feed-stale: 1</code>. The stale
        envelope deliberately carries{' '}
        <strong>
          no top-level <code>price</code>
        </strong>{' '}
        — the last known numbers are nested under <code>stale_record</code>, so a client that reads{' '}
        <code>price</code> without checking <code>status</code> cannot silently act on an outdated
        quote.
      </p>

      <CodeBlock
        language="json"
        title="GET /api/feeds/NEO-USD (stale)"
        code={`{
  "status": "stale",
  "degraded": true,
  "symbol": "NEO-USD",
  "error": "feed_quote_stale",
  "error_code": "FEED_QUOTE_STALE",
  "upstream_status": 503,
  "age_seconds": 1652577,
  "stale_after_seconds": 2700,
  "timestamp_iso": "2026-07-29T00:46:31.000Z",
  "stale_record": { "price": 2.287, "round_id": "42" }
}`}
      />
    </div>
  );
}
