'use client';

import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
  title?: string;
  description?: string;
  showRetry?: boolean;
  showHome?: boolean;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '400px',
            padding: '3rem',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: 'var(--ns-radius-lg)',
              boxShadow: 'var(--ns-shadow-md)',
              padding: '2rem',
              marginBottom: '2rem',
              maxWidth: '500px',
            }}
          >
            <AlertTriangle size={48} color="var(--error)" style={{ marginBottom: '1rem' }} />
            <h2
              style={{
                fontSize: '1.25rem',
                fontWeight: 800,
                color: 'var(--text-primary)',
                marginBottom: '0.75rem',
              }}
            >
              {this.props.title || 'Something went wrong'}
            </h2>
            <p
              style={{
                color: 'var(--text-secondary)',
                fontSize: '0.9rem',
                lineHeight: 1.6,
                marginBottom: '1rem',
              }}
            >
              {this.props.description ||
                'An unexpected error occurred. Please try again or return to the homepage.'}
            </p>
            {this.state.error && (
              <details
                style={{
                  textAlign: 'left',
                  marginTop: '1rem',
                  padding: '0.75rem',
                  background: 'var(--bg-panel)',
                  borderRadius: 'var(--ns-radius-sm)',
                  fontSize: '0.75rem',
                }}
              >
                <summary
                  style={{
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Error details
                </summary>
                <pre
                  style={{
                    color: 'var(--error)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.7rem',
                    marginTop: '0.5rem',
                    overflow: 'auto',
                    maxHeight: '150px',
                  }}
                >
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>

          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            {this.props.showRetry !== false && (
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '0.75rem 1.5rem',
                  background: 'var(--neo-green)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 'var(--ns-radius-full)',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                <RefreshCw size={16} /> Try Again
              </button>
            )}
            {this.props.showHome !== false && (
              <Link
                href="/"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '0.75rem 1.5rem',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-highlight)',
                  borderRadius: 'var(--ns-radius-full)',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  textDecoration: 'none',
                }}
              >
                Go Home
              </Link>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
