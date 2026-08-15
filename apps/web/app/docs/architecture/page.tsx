import { Layers, ArrowRight } from 'lucide-react';

const layers = [
  {
    title: '1. On-Chain Interface',
    body: 'Neo N3 contracts own request submission, fee accounting, callback routing, and verifier-checked fulfillment.',
  },
  {
    title: '2. Serverless Control Plane',
    body: 'Cloudflare Workers, Queues, and Workflows own ingress, validation, throttling, queueing, orchestration, and recovery.',
  },
  {
    title: '3. Durable State',
    body: 'Supabase stores request records, relayer jobs, control-plane jobs, automation state, feed snapshots, and logs.',
  },
  {
    title: '4. Confidential Execution',
    body: 'Role-split Oracle and DataFeed CVMs handle confidential execution only. Oracle serves request/response work; DataFeed serves publication only.',
  },
];

export default function DocsArchitecture() {
  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <Layers size={14} color="var(--neo-green)" />
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
          TECHNICAL SPEC
        </span>
      </div>
      <h1>System Architecture</h1>

      <p>
        Morpheus uses a four-layer production design. The confidential boundary is narrow: only
        decryption, private fetch, private compute, NeoDID private flows, and attested result
        creation enter the TEE.
      </p>

      <div
        style={{
          margin: '3rem 0',
          padding: '2rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-lg)',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.7rem',
            fontWeight: 800,
            marginBottom: '2rem',
            fontFamily: 'var(--font-mono)',
          }}
        >
          LOGICAL FLOW
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
          }}
        >
          {['Neo N3 Contracts', 'Control Plane', 'Durable State', 'Oracle / DataFeed CVMs'].map(
            (label, index) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  flex: '1 1 180px',
                  justifyContent: 'center',
                }}
              >
                <div
                  style={{
                    padding: '1rem',
                    border: '1px solid var(--neo-green)',
                    borderRadius: 'var(--ns-radius-sm)',
                    fontSize: '0.8rem',
                    minWidth: '140px',
                    background: index === 3 ? 'var(--neo-green-dim)' : 'transparent',
                    fontWeight: index === 3 ? 800 : 500,
                  }}
                >
                  {label}
                </div>
                {index < 3 ? <ArrowRight size={16} color="var(--text-muted)" /> : null}
              </div>
            )
          )}
        </div>
      </div>

      <h2>The Four Layers</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', margin: '2rem 0' }}>
        {layers.map((layer) => (
          <div
            key={layer.title}
            style={{
              padding: '1.5rem',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: '0.75rem' }}>{layer.title}</h3>
            <p style={{ marginBottom: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              {layer.body}
            </p>
          </div>
        ))}
      </div>

      <h2>Runtime Roles</h2>
      <ul>
        <li>
          <strong>Oracle CVM:</strong> request/response oracle, compute, NeoDID, confidential
          signing, and attested result generation.
        </li>
        <li>
          <strong>DataFeed CVM:</strong> isolated feed publication lane with higher operational
          priority.
        </li>
        <li>
          <strong>Shared topology:</strong> mainnet and testnet use the same Oracle and DataFeed
          CVMs and differ by path prefix and config.
        </li>
      </ul>

      <h2>Trust And Recovery Model</h2>
      <ul>
        <li>Clients seal secrets before submission.</li>
        <li>Control plane and relayer never decrypt sealed payloads.</li>
        <li>Accepted jobs are persisted to Supabase-backed durable state.</li>
        <li>Queues and Workflows recover stale jobs instead of assuming single-pass success.</li>
        <li>Pricefeeds stay isolated so interactive bursts do not stall market updates.</li>
      </ul>

      <h2>Support Stance</h2>
      <p>Neo N3 is the active supported production path across the full repository.</p>
    </div>
  );
}
