'use client';

import { Activity } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type FeedStatusResponse = {
  generated_at: string;
  network: string;
  status?: 'ok' | 'degraded';
  configured_pair_count: number;
  synced_configured_pair_count: number;
  fresh_configured_pair_count?: number;
  stale_configured_pair_count?: number;
  max_age_seconds?: number | null;
  oldest_pair?: string | null;
  alerts?: string[];
  configured: Array<{
    pair: string;
    storage_pair: string;
    synced: boolean;
    fresh?: boolean;
    status?: 'fresh' | 'stale' | 'not_synced';
    age_seconds?: number | null;
    stale_after_seconds?: number | null;
    market_closed?: boolean | null;
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

  // Age is the signal this page previously did not have. Before 2026-08 it had
  // no age column at all and printed a hardcoded 0.00% delta for every pair, so
  // a 19-day feed outage rendered identically to a healthy feed.
  function formatAge(seconds: number | null | undefined) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '-';
    if (seconds < 90) return `${Math.max(seconds, 0)}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m`;
    const hours = Math.round(seconds / 3600);
    if (hours < 48) return `${hours}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
  }

  function rowStatus(item: FeedStatusResponse['configured'][number]) {
    if (item.status) return item.status;
    return item.synced ? 'fresh' : 'not_synced';
  }

  function statusColor(status: string) {
    if (status === 'fresh') return 'var(--neo-green)';
    if (status === 'stale') return 'var(--error, #ff5c5c)';
    return 'var(--warning)';
  }

  const staleCount = data?.stale_configured_pair_count ?? 0;
  const degraded = data ? data.status === 'degraded' || staleCount > 0 : false;

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
        whether it is synced on-chain, and <strong>how old the on-chain record is</strong> against
        its staleness budget. A pair is healthy only when it is both synced and inside that budget —
        &ldquo;synced&rdquo; alone only means a record exists at some age. Delta against an
        independent quote is not currently measured, so it is reported as &ldquo;n/a&rdquo; rather
        than as zero.
      </p>

      {loading && <p style={{ color: 'var(--text-secondary)' }}>Loading live feed status...</p>}

      {data && degraded && (
        <div
          className="card-industrial"
          style={{
            marginBottom: '1.5rem',
            borderColor: 'var(--error, #ff5c5c)',
            background: 'rgba(255, 92, 92, 0.06)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontWeight: 800,
              color: 'var(--error, #ff5c5c)',
              marginBottom: '0.5rem',
            }}
          >
            FEED DEGRADED
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--text-secondary)' }}>
            {(data.alerts || []).slice(0, 12).map((alert) => (
              <li key={alert} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
                {alert}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-4" style={{ gap: '1rem', marginBottom: '2rem' }}>
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
                FRESH
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 900, color: 'var(--neo-green)' }}>
                {data.fresh_configured_pair_count ?? '-'}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                synced {data.synced_configured_pair_count} (any age)
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
                STALE
              </div>
              <div
                style={{
                  fontSize: '1.8rem',
                  fontWeight: 900,
                  color: staleCount > 0 ? 'var(--error, #ff5c5c)' : 'var(--text-primary)',
                }}
              >
                {data.stale_configured_pair_count ?? '-'}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                oldest {formatAge(data.max_age_seconds)}
                {data.oldest_pair ? ` (${data.oldest_pair})` : ''}
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
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'left' }}>Age</th>
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'left' }}>Status</th>
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
                            color: statusColor(rowStatus(item)),
                            fontFamily: 'var(--font-mono)',
                          }}
                          title={
                            typeof item.stale_after_seconds === 'number'
                              ? `budget ${formatAge(item.stale_after_seconds)}${
                                  item.market_closed ? ' (market closed)' : ''
                                }`
                              : undefined
                          }
                        >
                          {formatAge(item.age_seconds)}
                        </td>
                        <td
                          style={{
                            padding: '0.85rem 1rem',
                            color: statusColor(rowStatus(item)),
                            fontFamily: 'var(--font-mono)',
                            fontWeight: 700,
                          }}
                        >
                          {rowStatus(item).toUpperCase().replace('_', ' ')}
                        </td>
                        <td
                          style={{
                            padding: '0.85rem 1rem',
                            color:
                              item.delta_pct === null ? 'var(--text-muted)' : 'var(--text-primary)',
                            fontFamily: 'var(--font-mono)',
                          }}
                          title="No independent reference quote is fetched, so no delta is computed."
                        >
                          {item.delta_pct === null
                            ? 'n/a'
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
