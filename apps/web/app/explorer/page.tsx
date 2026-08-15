'use client';

import { Activity, ChevronRight } from 'lucide-react';
import { Dashboard } from '../../components/dashboard';

export default function ExplorerPage() {
  return (
    <div className="container oracle-tool-page" style={{ padding: 'calc(72px + 1.25rem) 0 3rem' }}>
      <div
        className="fade-in oracle-tool-hero"
        style={{
          marginBottom: '1.25rem',
          paddingBottom: '1rem',
          borderBottom: '1px solid var(--border-dim)',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '0.9rem',
          }}
        >
          <Activity size={14} color="var(--neo-green)" />
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 800,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0,
              fontFamily: 'var(--font-mono)',
            }}
          >
            MORPHEUS WORKBENCH
          </span>
        </div>
        <h1 style={{ marginBottom: '0.5rem' }}>Workbench</h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            maxWidth: '760px',
            fontSize: '1rem',
            lineHeight: 1.7,
            marginBottom: '0.9rem',
          }}
        >
          Inspect runtime health, data catalogs, oracle requests, compute routes, and attested
          network operations from one production-focused surface.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <a href="/docs/networks" className="btn-secondary" style={{ padding: '0.85rem 1.4rem' }}>
            Networks & Contracts <ChevronRight size={14} />
          </a>
          <a
            href="/docs/api-reference"
            className="btn-secondary"
            style={{ padding: '0.85rem 1.4rem' }}
          >
            API Reference <ChevronRight size={14} />
          </a>
        </div>
      </div>
      <Dashboard />
    </div>
  );
}
