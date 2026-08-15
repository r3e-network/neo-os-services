'use client';

type EncryptionErrorBannerProps = {
  message: string;
};

export function EncryptionErrorBanner({ message }: EncryptionErrorBannerProps) {
  return (
    <div
      role="status"
      style={{
        padding: '0.85rem 1rem',
        background: 'rgba(239, 68, 68, 0.08)',
        border: '1px solid rgba(239, 68, 68, 0.28)',
        color: 'var(--error)',
        fontSize: '0.85rem',
        lineHeight: 1.6,
      }}
    >
      {message}
    </div>
  );
}
