'use client';

import Link from 'next/link';
import { Lock, Cpu, Shield } from 'lucide-react';

type CallbackReadbackPanelProps = {
  requestType: string;
  oracleHash: string;
  universalConsumer: string;
};

export function CallbackReadbackPanel({
  requestType,
  oracleHash,
  universalConsumer,
}: CallbackReadbackPanelProps) {
  return (
    <div
      style={{
        padding: '1rem',
        background: 'var(--bg-panel)',
        borderLeft: '4px solid var(--neo-green)',
        borderTop: '1px solid var(--border-dim)',
        borderRight: '1px solid var(--border-dim)',
        borderBottom: '1px solid var(--border-dim)',
        borderRadius: 'var(--ns-radius-md)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          marginBottom: '0.5rem',
        }}
      >
        {requestType.includes('compute') ? (
          <Cpu size={16} color="var(--neo-green)" />
        ) : requestType.includes('privacy') ? (
          <Lock size={16} color="var(--neo-green)" />
        ) : (
          <Shield size={16} color="var(--neo-green)" />
        )}
        <strong style={{ color: 'var(--text-primary)' }}>Callback Readback</strong>
      </div>
      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        <div>
          1. Submit the request through <code>{oracleHash}</code>.
        </div>
        <div>
          2. Read the emitted <code>requestId</code> from your transaction result.
        </div>
        <div>
          3. If using the universal consumer, call <code>getCallback(requestId)</code> on{' '}
          <code>{universalConsumer}</code>.
        </div>
        <div>
          4. Verify <code>output_hash</code>, <code>attestation_hash</code>, and{' '}
          <code>tee_attestation.report_data</code> in{' '}
          <Link href="/verifier" style={{ color: 'var(--neo-green)', textDecoration: 'none' }}>
            Attestation Verifier
          </Link>
          .
        </div>
      </div>
    </div>
  );
}
