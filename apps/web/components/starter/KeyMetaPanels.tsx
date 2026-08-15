'use client';

import type { RuntimeStatus } from '@/components/dashboard/oracleReadiness';

type KeyMetaPanelsProps = {
  oracleKeyMeta: any;
  keyStatus?: RuntimeStatus;
};

export function KeyMetaPanels({ oracleKeyMeta, keyStatus }: KeyMetaPanelsProps) {
  const statusColor = keyStatus?.level === 'ready' ? 'var(--neo-green)' : 'var(--warning)';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
      <div
        style={{
          padding: '1rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-md)',
        }}
      >
        <div
          style={{
            fontSize: '0.65rem',
            color: 'var(--text-secondary)',
            fontWeight: 800,
            marginBottom: '0.35rem',
            fontFamily: 'var(--font-mono)',
          }}
        >
          ALGORITHM
        </div>
        <div
          style={{
            fontSize: '0.78rem',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            wordBreak: 'break-word',
          }}
        >
          {oracleKeyMeta?.algorithm || 'X25519-HKDF-SHA256-AES-256-GCM'}
        </div>
      </div>
      <div
        style={{
          padding: '1rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-md)',
        }}
      >
        <div
          style={{
            fontSize: '0.65rem',
            color: 'var(--text-secondary)',
            fontWeight: 800,
            marginBottom: '0.35rem',
            fontFamily: 'var(--font-mono)',
          }}
        >
          KEY SOURCE
        </div>
        <div
          style={{
            fontSize: '0.78rem',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {oracleKeyMeta?.key_source || 'loading'}
        </div>
      </div>
      {keyStatus && keyStatus.level !== 'ready' && (
        <div
          style={{
            gridColumn: '1 / -1',
            padding: '1rem',
            background: 'var(--bg-panel)',
            border: `1px solid ${statusColor}`,
            borderLeft: `4px solid ${statusColor}`,
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'var(--text-secondary)',
              fontWeight: 800,
              marginBottom: '0.35rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            KEY READINESS
          </div>
          <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{keyStatus.label}:</strong>{' '}
            {keyStatus.detail}
          </div>
        </div>
      )}
    </div>
  );
}
