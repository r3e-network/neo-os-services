'use client';

import { Shield } from 'lucide-react';

type ZeroCodeTestModePanelProps = {
  universalConsumer: string;
  oracleHash: string;
  environmentLabel: string;
  neoGasHash: string;
};

export function ZeroCodeTestModePanel({
  universalConsumer,
  oracleHash,
  environmentLabel,
  neoGasHash,
}: ZeroCodeTestModePanelProps) {
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
        <Shield size={16} color="var(--neo-green)" />
        <strong style={{ color: 'var(--text-primary)' }}>
          Zero-Code {environmentLabel} Test Mode
        </strong>
      </div>
      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
        <div>
          1. Keep callback hash at <code>{universalConsumer}</code>.
        </div>
        <div>
          2. Before calling <code>request</code>, pre-fund fee credit with a GAS transfer to{' '}
          <code>{oracleHash}</code>.
        </div>
        <div>
          3. Neo N3 GAS token hash: <code>{neoGasHash}</code>.
        </div>
        <div>
          4. Oracle will consume prepaid credit from the callback contract first, otherwise from the
          requester address.
        </div>
        <div>
          5. After submission, call <code>getCallback(requestId)</code> on{' '}
          <code>{universalConsumer}</code>.
        </div>
      </div>
    </div>
  );
}
