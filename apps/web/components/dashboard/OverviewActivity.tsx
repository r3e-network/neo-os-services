'use client';

import { Clock, Database, ExternalLink, RefreshCcw } from 'lucide-react';
import { DEFAULT_PAIRS } from '@/lib/onchain-data';
import { getFeedDescriptor, getFeedDisplaySymbol } from '@/lib/feed-defaults';
import { SkeletonGrid } from '@/components/ui/Skeleton';
import { getContractExplorerUrl } from './networkSelection';

type OnchainRecord = {
  pair: string;
  price_display: string;
  timestamp: string;
  timestamp_iso: string | null;
  attestation_hash: string;
};

interface OverviewActivityProps {
  isInitialLoading: boolean;
  isRefreshing: boolean;
  selectedPair: string;
  setSelectedPair: (pair: string) => void;
  recordsByPair: Map<string, OnchainRecord>;
  onRefresh: () => void;
  networkKey: string;
  datafeedContract: string;
  datafeedDomain: string;
}

export function OverviewActivity({
  isInitialLoading,
  isRefreshing,
  selectedPair,
  setSelectedPair,
  recordsByPair,
  onRefresh,
  networkKey,
  datafeedContract,
  datafeedDomain,
}: OverviewActivityProps) {
  const datafeedExplorerUrl = getContractExplorerUrl(networkKey, datafeedContract);

  return (
    <div className="card-industrial stagger-2" style={{ padding: '0' }}>
      <div
        style={{
          padding: '1.5rem 2rem',
          borderBottom: '1px solid var(--border-dim)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(83, 58, 253, 0.045)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Database size={16} color="var(--neo-green)" />
          <h3
            style={{
              fontSize: '0.85rem',
              fontWeight: 800,
              color: 'var(--text-primary)',
              textTransform: 'uppercase',
              letterSpacing: 0,
              fontFamily: 'var(--font-mono)',
            }}
          >
            On-Chain Feed Records
          </h3>
          {!isInitialLoading && (
            <span
              className="badge-outline"
              style={{
                color: 'var(--text-muted)',
                borderColor: 'var(--border-dim)',
                padding: '2px 8px',
                fontSize: '0.6rem',
              }}
            >
              {DEFAULT_PAIRS.length} pairs
            </span>
          )}
        </div>
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '0.7rem',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
          }}
        >
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
          <RefreshCcw size={12} className={isRefreshing ? 'spin' : ''} />
        </button>
      </div>

      {isInitialLoading ? (
        <SkeletonGrid count={6} />
      ) : (
        <div
          className="feed-records-scroll"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '1px',
            background: 'var(--border-dim)',
            maxHeight: '560px',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            borderBottomLeftRadius: '20px',
            borderBottomRightRadius: '20px',
          }}
        >
          {DEFAULT_PAIRS.map((pair) => {
            const record = recordsByPair.get(pair);
            const displayPair = getFeedDisplaySymbol(pair);
            const descriptor = getFeedDescriptor(pair);
            return (
              <div
                key={pair}
                onClick={() => setSelectedPair(pair)}
                role="button"
                tabIndex={0}
                style={{
                  padding: '1.5rem',
                  background: selectedPair === pair ? 'var(--neo-green-dim)' : 'var(--bg-panel)',
                  position: 'relative',
                  transition: 'background 0.2s',
                  textAlign: 'left',
                  cursor: 'pointer',
                  boxShadow:
                    selectedPair === pair ? 'inset 0 0 0 1px rgba(22, 199, 132, 0.32)' : 'none',
                }}
                onMouseEnter={(event) => {
                  if (selectedPair !== pair) {
                    event.currentTarget.style.background = 'var(--bg-main)';
                  }
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background =
                    selectedPair === pair ? 'var(--neo-green-dim)' : 'var(--bg-panel)';
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') setSelectedPair(pair);
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: '1.5rem',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <span
                      style={{
                        fontWeight: 800,
                        fontSize: '1.1rem',
                        letterSpacing: 0,
                        display: 'block',
                      }}
                    >
                      {displayPair}
                    </span>
                    <span
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--text-secondary)',
                        display: 'block',
                        marginTop: '0.2rem',
                      }}
                    >
                      {descriptor?.label || descriptor?.meaning || displayPair}
                    </span>
                    <span
                      style={{
                        fontSize: '0.58rem',
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {datafeedDomain || 'NNS not configured'}
                    </span>
                  </div>
                  {datafeedExplorerUrl && (
                    <a
                      href={datafeedExplorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--text-muted)', transition: 'color 0.2s' }}
                      onMouseEnter={(event) => {
                        event.currentTarget.style.color = 'var(--text-primary)';
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.color = 'var(--text-muted)';
                      }}
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '8px',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span
                    style={{
                      fontSize: '1.75rem',
                      fontWeight: 900,
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: 0,
                      color: record ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                  >
                    {record ? `$${record.price_display}` : '$--.------'}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: '1.5rem',
                  }}
                >
                  <div
                    style={{
                      fontSize: '0.65rem',
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    <Clock
                      size={10}
                      style={{
                        verticalAlign: 'middle',
                        marginRight: '4px',
                        display: 'inline-block',
                      }}
                    />
                    {record?.timestamp_iso
                      ? new Date(record.timestamp_iso).toLocaleTimeString()
                      : 'Awaiting sync...'}
                  </div>
                  {record && (
                    <span
                      className="badge-outline"
                      style={{
                        color: 'var(--neo-green)',
                        borderColor: 'var(--neo-green)',
                        padding: '2px 6px',
                        fontSize: '0.5rem',
                      }}
                    >
                      VERIFIED
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
