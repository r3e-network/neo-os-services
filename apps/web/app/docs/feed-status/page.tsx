'use client';

import { Activity } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type FeedStatusResponse = {
  generated_at: string;
  network: string;
  configured_pair_count: number;
  synced_configured_pair_count: number;
  configured: Array<{
    pair: string;
    storage_pair: string;
    synced: boolean;
    descriptor: {
      label: string;
      category: string;
      meaning: string;
      sourceSymbol: string;
      unit: string;
      note?: string;
    } | null;
    chain: {
      pair: string;
      price_display: string;
      timestamp_iso: string | null;
      attestation_hash: string;
    } | null;
    live:
      | {
          price?: string;
          raw_price?: string;
        }
      | { error?: string }
      | null;
    delta_pct: number | null;
  }>;
};

export default function FeedStatusPage() {
  const [data, setData] = useState<FeedStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch('/api/feeds/status');
        const body = await response.json().catch(() => null);
        if (!cancelled && body) setData(body);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    const groups: Record<string, FeedStatusResponse['configured']> = {};
    for (const item of data?.configured || []) {
      const key = item.descriptor?.category || 'Other';
      groups[key] ||= [];
      groups[key].push(item);
    }
    return groups;
  }, [data]);

  function renderLiveValue(item: FeedStatusResponse['configured'][number]) {
    if (item.live && 'price' in item.live && item.live.price) {
      return `$${item.live.price}`;
    }
    if (item.live && 'error' in item.live) {
      return 'Error';
    }
    return '-';
  }

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
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
          LIVE OPERATIONS
        </span>
      </div>

      <h1>Feed Status</h1>
      <p
        className="lead"
        style={{ fontSize: '1.05rem', color: 'var(--text-primary)', marginBottom: '2rem' }}
      >
        Live status for every configured canonical feed pair. This page shows what the pair means,
        whether it is already synced on-chain, and how the current on-chain value compares with the
        live TwelveData quote.
      </p>

      {loading && <p style={{ color: 'var(--text-secondary)' }}>Loading live feed status...</p>}

      {data && (
        <>
          <div className="grid grid-3" style={{ gap: '1rem', marginBottom: '2rem' }}>
            <div className="card-industrial">
              <div
                style={{
                  fontSize: '0.7rem',
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                  marginBottom: '0.4rem',
                }}
              >
                CONFIGURED
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 900 }}>
                {data.configured_pair_count}
              </div>
            </div>
            <div className="card-industrial">
              <div
                style={{
                  fontSize: '0.7rem',
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                  marginBottom: '0.4rem',
                }}
              >
                SYNCED ON-CHAIN
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 900 }}>
                {data.synced_configured_pair_count}
              </div>
            </div>
            <div className="card-industrial">
              <div
                style={{
                  fontSize: '0.7rem',
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                  marginBottom: '0.4rem',
                }}
              >
                LAST REFRESH
              </div>
              <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>
                {new Date(data.generated_at).toLocaleString()}
              </div>
            </div>
          </div>

          {Object.entries(grouped).map(([category, items]) => (
            <section key={category} style={{ marginBottom: '2rem' }}>
              <h2>{category}</h2>
              <div
                style={{
                  overflowX: 'auto',
                  border: '1px solid var(--border-dim)',
                  borderRadius: 'var(--ns-radius-sm)',
                  background: 'var(--bg-panel)',
                }}
              >
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr
                      style={{
                        borderBottom: '1px solid var(--border-dim)',
                        background: 'rgba(83, 58, 253, 0.045)',
                      }}
                    >
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'left' }}>Pair</th>
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'left' }}>Asset</th>
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'left' }}>Meaning</th>
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'left' }}>Chain</th>
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'left' }}>Live</th>
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'left' }}>Delta</th>
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'left' }}>Unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.pair} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                        <td
                          style={{
                            padding: '0.85rem 1rem',
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          {item.pair}
                        </td>
                        <td style={{ padding: '0.85rem 1rem', color: 'var(--text-primary)' }}>
                          {item.descriptor?.label || '-'}
                        </td>
                        <td style={{ padding: '0.85rem 1rem', color: 'var(--text-secondary)' }}>
                          {item.descriptor?.meaning || '-'}
                        </td>
                        <td
                          style={{
                            padding: '0.85rem 1rem',
                            color: item.synced ? 'var(--text-primary)' : 'var(--warning)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {item.chain?.price_display
                            ? `$${item.chain.price_display}`
                            : 'Not synced'}
                        </td>
                        <td
                          style={{
                            padding: '0.85rem 1rem',
                            color: 'var(--text-primary)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {renderLiveValue(item)}
                        </td>
                        <td
                          style={{
                            padding: '0.85rem 1rem',
                            color:
                              item.delta_pct === null ? 'var(--text-muted)' : 'var(--text-primary)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {item.delta_pct === null
                            ? '-'
                            : `${item.delta_pct >= 0 ? '+' : ''}${item.delta_pct.toFixed(2)}%`}
                        </td>
                        <td style={{ padding: '0.85rem 1rem', color: 'var(--text-secondary)' }}>
                          {item.descriptor?.unit || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
