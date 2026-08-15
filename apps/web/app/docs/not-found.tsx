import Link from 'next/link';
import { BookOpen, Home } from 'lucide-react';

export default function DocsNotFound() {
  return (
    <div
      className="fade-in"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 'calc(100vh - 200px)',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: '480px', width: '100%', textAlign: 'center' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '10px',
            padding: '8px 20px',
            background: 'rgba(239, 68, 68, 0.05)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: 'var(--ns-radius-full)',
            marginBottom: '2rem',
          }}
        >
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              color: 'var(--error)',
              letterSpacing: 0,
              fontFamily: 'var(--font-mono)',
            }}
          >
            ERROR 404
          </span>
        </div>

        <h1
          style={{
            fontSize: 'clamp(2rem, 4vw, 3rem)',
            fontWeight: 800,
            letterSpacing: 0,
            lineHeight: 1.1,
            marginBottom: '1rem',
          }}
        >
          Document Not Found
        </h1>

        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '1rem',
            lineHeight: 1.7,
            marginBottom: '2rem',
            maxWidth: '380px',
            marginLeft: 'auto',
            marginRight: 'auto',
          }}
        >
          The document you requested does not exist or may have been renamed. Browse the sidebar or
          return to the docs index.
        </p>

        <div
          style={{
            display: 'flex',
            gap: '1rem',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Link
            href="/docs"
            className="btn-ata"
            style={{
              padding: '0.85rem 2rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <BookOpen size={14} />
            Docs Index
          </Link>
          <Link
            href="/"
            className="btn-secondary"
            style={{
              padding: '0.85rem 1.5rem',
              textTransform: 'uppercase',
              fontSize: '0.8rem',
              letterSpacing: 0,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <Home size={14} />
            Home
          </Link>
        </div>

        <div
          style={{
            marginTop: '2.5rem',
            padding: '1.25rem',
            background: 'rgba(83, 58, 253, 0.045)',
            border: '1px solid var(--border-dim)',
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <p
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              lineHeight: 1.6,
              margin: 0,
              fontFamily: 'var(--font-mono)',
            }}
          >
            If you followed a link to get here, please{' '}
            <a
              href="https://github.com/r3e-network/neo-os-services/issues"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--neo-green)', textDecoration: 'none' }}
            >
              report it on GitHub
            </a>{' '}
            so we can fix it.
          </p>
        </div>
      </div>
    </div>
  );
}
