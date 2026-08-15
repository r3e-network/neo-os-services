'use client';

type NeoLineManualEntryPanelProps = {
  oracleHash: string;
  requestType: string;
  callbackHash: string;
  callbackMethod: string;
};

export function NeoLineManualEntryPanel({
  oracleHash,
  requestType,
  callbackHash,
  callbackMethod,
}: NeoLineManualEntryPanelProps) {
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
        NEOLINE MANUAL ENTRY
      </div>
      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Contract:</strong>{' '}
          <code>{oracleHash}</code>
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Method:</strong> <code>request</code>
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Arg 1 / String:</strong>{' '}
          <code>{requestType}</code>
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Arg 2 / ByteArray:</strong> use the
          base64 payload above
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Arg 3 / Hash160:</strong>{' '}
          <code>{callbackHash}</code>
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary)' }}>Arg 4 / String:</strong>{' '}
          <code>{callbackMethod}</code>
        </div>
      </div>
    </div>
  );
}
