'use client';

import type { LiveQuote } from '@/lib/dashboard-types';
import { getFeedDescriptor } from '@/lib/feed-defaults';

type OnchainRecord = {
  pair: string;
  price_display: string;
  timestamp: string;
  timestamp_iso: string | null;
  attestation_hash: string;
};

interface OverviewNetworkProps {
  selectedPair: string;
  selectedRecord: OnchainRecord | null;
  selectedDescriptor: ReturnType<typeof getFeedDescriptor>;
  liveQuote: LiveQuote | null;
  liveQuoteLoading: boolean;
  liveDeltaPct: number | null;
}

export function OverviewNetwork({
  selectedPair,
  selectedRecord,
  selectedDescriptor,
  liveQuote,
  liveQuoteLoading,
  liveDeltaPct,
}: OverviewNetworkProps) {
  return (
    <>
      <section className="card-industrial stagger-2" style={{ padding: '2rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1.25rem',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800 }}>
              Selected Feed Detail
            </h3>
            <div
              style={{ marginTop: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}
            >
              {selectedDescriptor?.label || selectedPair}
            </div>
          </div>
          <span
            className="badge-outline"
            style={{ color: 'var(--neo-green)', borderColor: 'var(--neo-green)' }}
          >
            {selectedDescriptor?.category || 'Feed'}
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
          }}
        >
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
              PAIR
            </div>
            <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {selectedPair}
            </div>
          </div>
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
              MEANING
            </div>
            <div style={{ color: 'var(--text-primary)' }}>
              {selectedDescriptor?.meaning || 'No description available'}
            </div>
          </div>
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
              CHAIN VALUE
            </div>
            <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {selectedRecord ? `$${selectedRecord.price_display}` : 'Not synced yet'}
            </div>
          </div>
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
              REAL-TIME SOURCE
            </div>
            <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {liveQuoteLoading
                ? 'Loading...'
                : liveQuote?.price
                  ? `$${liveQuote.price}`
                  : 'Unavailable'}
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
            marginTop: '1rem',
          }}
        >
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
              TWELVEDATA SYMBOL
            </div>
            <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {selectedDescriptor?.sourceSymbol || '-'}
            </div>
          </div>
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
              UNIT
            </div>
            <div style={{ color: 'var(--text-primary)' }}>{selectedDescriptor?.unit || '-'}</div>
          </div>
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
              LIVE VS CHAIN
            </div>
            <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {liveDeltaPct === null
                ? '-'
                : `${liveDeltaPct >= 0 ? '+' : ''}${liveDeltaPct.toFixed(2)}%`}
            </div>
          </div>
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
              LAST ON-CHAIN UPDATE
            </div>
            <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {selectedRecord?.timestamp_iso
                ? new Date(selectedRecord.timestamp_iso).toLocaleString()
                : '-'}
            </div>
          </div>
        </div>

        {selectedDescriptor?.note && (
          <p
            style={{
              marginTop: '1rem',
              marginBottom: 0,
              color: 'var(--text-secondary)',
              lineHeight: 1.7,
            }}
          >
            <strong style={{ color: 'var(--text-primary)' }}>Note:</strong>{' '}
            {selectedDescriptor.note}
          </p>
        )}
      </section>
    </>
  );
}
