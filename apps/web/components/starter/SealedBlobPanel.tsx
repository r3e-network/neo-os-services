'use client';

type SealedBlobPanelProps = {
  blob: string;
};

export function SealedBlobPanel({ blob }: SealedBlobPanelProps) {
  return (
    <div
      style={{
        padding: '1rem',
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-dim)',
        borderLeft: '3px solid var(--neo-green)',
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
        SEALED BLOB
      </div>
      <div
        style={{
          fontSize: '0.75rem',
          color: 'var(--neo-green)',
          wordBreak: 'break-all',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {blob}
      </div>
    </div>
  );
}
