'use client';

type RequestTypePanelProps = {
  requestType: string;
};

export function RequestTypePanel({ requestType }: RequestTypePanelProps) {
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
          marginBottom: '0.35rem',
          fontFamily: 'var(--font-mono)',
        }}
      >
        REQUEST TYPE
      </div>
      <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
        {requestType}
      </div>
    </div>
  );
}
