'use client';

import { useEffect, useState } from 'react';
import type { ProviderSummary } from '@/lib/dashboard-types';
import { Search, Zap, Activity, Info, Globe, Filter } from 'lucide-react';
import { EmptyStateArt } from '@/components/illustrations';
import { DEFAULT_PAIRS } from '@/lib/onchain-data';
import {
  getAllFeedDescriptors,
  getFeedDescriptor,
  getFeedDisplaySymbol,
} from '@/lib/feed-defaults';

interface ProvidersTabProps {
  providers: ProviderSummary[];
}

export function ProvidersTab({ providers }: ProvidersTabProps) {
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_PAIRS);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [selectedPair, setSelectedPair] = useState<string>(DEFAULT_PAIRS[0]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/feeds/catalog');
        const body = await res.json();
        if (Array.isArray(body.pairs) && body.pairs.length > 0) {
          setSymbols(body.pairs.sort());
        }
      } catch (err) {
        console.error('Failed to load symbols, using defaults', err);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const filteredSymbols = symbols.filter((s) => {
    const normalizedS = s.toLowerCase();
    const normalizedTerm = searchTerm.toLowerCase();
    return (
      normalizedS.includes(normalizedTerm) || normalizedS.replace('-', '').includes(normalizedTerm)
    );
  });
  const selectedDescriptor = getFeedDescriptor(selectedPair);
  const descriptorList = getAllFeedDescriptors().filter((item) =>
    filteredSymbols.includes(item.pair)
  );

  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          borderBottom: '1px solid var(--border-dim)',
          paddingBottom: '1rem',
        }}
      >
        <div>
          <h2
            style={{
              fontSize: '2rem',
              fontWeight: 900,
              letterSpacing: 0,
              marginBottom: '0.5rem',
            }}
          >
            Data Catalog
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            Explore native adapters and indexable price pairs.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <a
            href="https://twelvedata.com/stocks"
            target="_blank"
            className="btn-secondary"
            style={{ padding: '0.5rem 1rem', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}
          >
            <Globe size={14} /> Explore TwelveData
          </a>
        </div>
      </div>

      <div className="grid grid-2" style={{ gap: '2rem' }}>
        <div className="card-industrial stagger-1" style={{ padding: '0' }}>
          <div
            style={{
              padding: '1.5rem',
              borderBottom: '1px solid var(--border-dim)',
              background: 'rgba(83, 58, 253, 0.045)',
            }}
          >
            <h3
              style={{
                fontSize: '0.9rem',
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                textTransform: 'uppercase',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <Zap className="text-neo" size={16} /> Built-in Adapters
            </h3>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              maxHeight: '500px',
              overflowY: 'auto',
            }}
          >
            {providers.length === 0 && (
              <div
                style={{
                  padding: '2.5rem 1.5rem',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                }}
              >
                <EmptyStateArt size={168} title="No providers loaded yet" />
                <div
                  style={{
                    fontSize: '0.85rem',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    marginTop: '0.75rem',
                  }}
                >
                  No providers loaded yet.
                </div>
                <div style={{ fontSize: '0.8rem', marginTop: '0.5rem', lineHeight: 1.6 }}>
                  Provider data is fetched when you switch to this tab. If no data appears, the API
                  may be unavailable.
                </div>
              </div>
            )}
            {providers.map((p) => (
              <div
                key={p.id}
                style={{
                  padding: '1.5rem',
                  borderBottom: '1px solid var(--border-dim)',
                  transition: 'background 0.2s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-panel)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '1rem',
                  }}
                >
                  <span
                    style={{
                      fontWeight: 800,
                      fontSize: '1rem',
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {p.id.toUpperCase()}
                  </span>
                  <div
                    className="badge-outline"
                    style={{ color: 'var(--neo-green)', borderColor: 'var(--neo-green)' }}
                  >
                    NATIVE
                  </div>
                </div>
                <p
                  style={{
                    fontSize: '0.85rem',
                    color: 'var(--text-secondary)',
                    marginBottom: '1.5rem',
                    lineHeight: 1.6,
                  }}
                >
                  {p.description}
                </p>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.7rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)' }}>
                    Support:{' '}
                    <span style={{ color: 'var(--text-primary)' }}>{p.supports?.join(', ')}</span>
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    Auth:{' '}
                    <span style={{ color: 'var(--text-primary)' }}>
                      {p.auth === 'none' ? 'Public' : 'Encrypted Key'}
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          className="card-industrial stagger-2"
          style={{ padding: '0', display: 'flex', flexDirection: 'column' }}
        >
          <div
            style={{
              padding: '1.5rem',
              borderBottom: '1px solid var(--border-dim)',
              background: 'rgba(83, 58, 253, 0.045)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <h3
              style={{
                fontSize: '0.9rem',
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                textTransform: 'uppercase',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <Activity className="text-accent-blue" size={16} /> Available Pairs ({symbols.length})
            </h3>
            <Filter size={14} color="var(--text-muted)" />
          </div>

          <div style={{ padding: '1.5rem', flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="form-group" style={{ marginBottom: '1.5rem' }}>
              <div style={{ position: 'relative' }}>
                <input
                  className="neo-input"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search index (e.g. BTC, NEO)..."
                  aria-label="Search pairs"
                  style={{ paddingLeft: '40px', background: 'var(--bg-panel)' }}
                />
                <Search
                  size={16}
                  style={{
                    position: 'absolute',
                    left: '14px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-muted)',
                  }}
                />
              </div>
            </div>

            <div
              style={{
                maxHeight: '380px',
                overflowY: 'auto',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                gap: '8px',
                alignContent: 'start',
              }}
            >
              {isLoading ? (
                <div
                  style={{
                    padding: '4rem',
                    textAlign: 'center',
                    gridColumn: '1/-1',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8rem',
                  }}
                >
                  Loading pairs...
                </div>
              ) : (
                filteredSymbols.map((s) => (
                  <button
                    key={s}
                    style={{
                      padding: '0.75rem',
                      textAlign: 'center',
                      fontSize: '0.75rem',
                      background: selectedPair === s ? 'var(--neo-green-dim)' : 'var(--bg-panel)',
                      border: '1px solid',
                      borderColor: selectedPair === s ? 'var(--neo-green)' : 'var(--border-dim)',
                      color: selectedPair === s ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontFamily: 'var(--font-mono)',
                      borderRadius: 'var(--ns-radius-xs)',
                      transition: 'all 0.2s',
                      cursor: 'pointer',
                    }}
                    onClick={() => setSelectedPair(s)}
                  >
                    {getFeedDisplaySymbol(s)}
                  </button>
                ))
              )}
              {!isLoading && filteredSymbols.length === 0 && (
                <div
                  style={{
                    gridColumn: '1/-1',
                    padding: '2rem',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8rem',
                  }}
                >
                  No matching pairs
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {selectedDescriptor && (
        <section className="card-industrial stagger-3" style={{ padding: '2rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1.25rem',
            }}
          >
            <h4 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0 }}>Pair Semantics</h4>
            <span
              className="badge-outline"
              style={{ color: 'var(--neo-green)', borderColor: 'var(--neo-green)' }}
            >
              {selectedDescriptor.category}
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
                {selectedDescriptor.pair}
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
              <div style={{ color: 'var(--text-primary)' }}>{selectedDescriptor.meaning}</div>
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
                TWELVEDATA SYMBOL
              </div>
              <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                {selectedDescriptor.sourceSymbol}
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
                ON-CHAIN UNIT
              </div>
              <div style={{ color: 'var(--text-primary)' }}>{selectedDescriptor.unit}</div>
            </div>
          </div>
          {selectedDescriptor.note && (
            <p
              style={{
                marginTop: '1rem',
                marginBottom: 0,
                color: 'var(--text-secondary)',
                lineHeight: 1.6,
              }}
            >
              <strong style={{ color: 'var(--text-primary)' }}>Note:</strong>{' '}
              {selectedDescriptor.note}
            </p>
          )}
        </section>
      )}

      <section
        className="card-industrial stagger-3"
        style={{ padding: '1.5rem', borderLeft: '4px solid var(--warning)' }}
      >
        <h4
          style={{
            marginTop: 0,
            marginBottom: '0.75rem',
            color: 'var(--text-primary)',
            fontSize: '0.95rem',
            fontWeight: 800,
          }}
        >
          Canonical Storage Key
        </h4>
        <p style={{ marginBottom: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          The canonical on-chain key format is provider-scoped. For the current main catalog, use
          <code> TWELVEDATA:&lt;PAIR&gt; </code>
          everywhere in contracts, frontend requests, and documentation. If a new data source is
          added later, it should introduce a new explicit prefix rather than reusing bare pair
          names.
        </p>
      </section>

      <section className="card-industrial stagger-3" style={{ padding: '0' }}>
        <div
          style={{
            padding: '1rem 1.5rem',
            borderBottom: '1px solid var(--border-dim)',
            background: 'rgba(83, 58, 253, 0.045)',
          }}
        >
          <h4
            style={{
              margin: 0,
              fontSize: '0.9rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Canonical Pair Table
          </h4>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-dim)' }}>
                <th style={{ padding: '0.9rem 1rem', textAlign: 'left' }}>Pair</th>
                <th style={{ padding: '0.9rem 1rem', textAlign: 'left' }}>Meaning</th>
                <th style={{ padding: '0.9rem 1rem', textAlign: 'left' }}>TwelveData</th>
                <th style={{ padding: '0.9rem 1rem', textAlign: 'left' }}>Unit</th>
              </tr>
            </thead>
            <tbody>
              {descriptorList.map((item) => (
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
                  <td style={{ padding: '0.85rem 1rem', color: 'var(--text-secondary)' }}>
                    {item.meaning}
                  </td>
                  <td
                    style={{
                      padding: '0.85rem 1rem',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {item.sourceSymbol}
                  </td>
                  <td style={{ padding: '0.85rem 1rem', color: 'var(--text-secondary)' }}>
                    {item.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="card-industrial stagger-3"
        style={{
          padding: '2rem',
          borderLeft: '4px solid var(--accent-blue)',
          background: 'linear-gradient(90deg, rgba(59, 130, 246, 0.05) 0%, transparent 50%)',
        }}
      >
        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
          <Info color="var(--accent-blue)" size={24} style={{ flexShrink: 0 }} />
          <div>
            <h4 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.5rem' }}>
              Custom URL Construction
            </h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>
              Morpheus is not limited to the pairs listed above. You can query any REST API via the{' '}
              <strong>Custom URL</strong> mode, but the supported user flow is still: build the
              payload locally, encrypt secret fields in the <strong>Oracle Payload</strong> tab,
              then submit the request through the on-chain Oracle contract.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
