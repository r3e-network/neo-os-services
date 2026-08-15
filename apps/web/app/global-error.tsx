'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect, useState } from 'react';

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  if (typeof document === 'undefined') return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [digestCopied, setDigestCopied] = useState(false);

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  const handleCopyDigest = async () => {
    if (!error?.digest) return;
    const ok = await copyText(error.digest);
    if (ok) {
      setDigestCopied(true);
      setTimeout(() => setDigestCopied(false), 2000);
    }
  };

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem',
          background: 'var(--bg-main, #f4f5f7)',
          color: 'var(--text-primary, #1e1e2e)',
          fontFamily:
            'var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
        }}
      >
        <div
          style={{
            width: 'min(540px, calc(100vw - 32px))',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '10px',
              padding: '8px 20px',
              background: 'rgba(239, 68, 68, 0.05)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: 'var(--ns-radius-full, 9999px)',
              marginBottom: '2rem',
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: 0,
                textTransform: 'uppercase',
                color: 'var(--error)',
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              }}
            >
              SYSTEM ERROR
            </span>
          </div>
          <h1
            style={{
              margin: '0 0 12px',
              fontSize: 'clamp(2rem, 5vw, 3rem)',
              fontWeight: 800,
              letterSpacing: 0,
              lineHeight: 1.1,
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              margin: '0 auto 2rem',
              color: 'var(--text-secondary, #5b6478)',
              lineHeight: 1.7,
              fontSize: '1rem',
              maxWidth: '420px',
            }}
          >
            An unexpected error occurred. The failure has been captured for investigation. You can
            retry the current route without leaving the application.
          </p>
          {error?.digest && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                margin: '0 0 2rem',
                fontSize: '0.75rem',
                color: 'var(--text-muted, #8a92a6)',
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              }}
            >
              <span>Digest: {error.digest}</span>
              <button
                type="button"
                onClick={handleCopyDigest}
                aria-label="Copy error digest for support"
                style={{
                  border: '1px solid var(--border-highlight, #d8dde6)',
                  borderRadius: 'var(--ns-radius-xs, 6px)',
                  background: 'var(--bg-card, #ffffff)',
                  color: digestCopied
                    ? 'var(--neo-green, #16a34a)'
                    : 'var(--text-secondary, #5b6478)',
                  cursor: 'pointer',
                  padding: '2px 8px',
                  fontSize: '0.7rem',
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                }}
              >
                {digestCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => reset()}
              style={{
                border: 0,
                borderRadius: 'var(--ns-radius-full, 9999px)',
                padding: '0.85rem 2rem',
                fontWeight: 700,
                cursor: 'pointer',
                background: 'var(--accent-purple, #7b61ff)',
                color: '#ffffff',
                fontSize: '0.8rem',
                letterSpacing: 0,
                textTransform: 'uppercase',
                boxShadow: '0 8px 24px rgba(123, 97, 255, 0.22)',
              }}
            >
              Retry
            </button>
            <a
              href="/"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.85rem 2rem',
                border: '1px solid var(--border-highlight, #d8dde6)',
                borderRadius: 'var(--ns-radius-full, 9999px)',
                background: 'var(--bg-card, #ffffff)',
                color: 'var(--text-primary, #1e1e2e)',
                textDecoration: 'none',
                fontWeight: 700,
                fontSize: '0.8rem',
                letterSpacing: 0,
                textTransform: 'uppercase',
              }}
            >
              Go Home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
