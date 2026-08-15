'use client';

type NeoN3CallArgumentsPanelProps = {
  requestType: string;
  callbackHash: string;
  callbackMethod: string;
  requestFeeDisplay?: string;
};

export function NeoN3CallArgumentsPanel({
  requestType,
  callbackHash,
  callbackMethod,
  requestFeeDisplay = 'unverified',
}: NeoN3CallArgumentsPanelProps) {
  return (
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
          marginBottom: '0.5rem',
          fontFamily: 'var(--font-mono)',
        }}
      >
        NEO N3 CALL ARGUMENTS
      </div>
      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Arg 1:</strong>{' '}
          <code>{requestType}</code>
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Arg 2:</strong> UTF-8 payload JSON bytes
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Arg 3:</strong> callback contract ={' '}
          <code>Runtime.ExecutingScriptHash</code> for your own consumer, or{' '}
          <code>{callbackHash}</code> for direct wallet testing
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Arg 4:</strong> callback method ={' '}
          <code>{callbackMethod}</code>
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Fee:</strong>{' '}
          <code>{requestFeeDisplay}</code>
        </div>
      </div>
    </div>
  );
}
