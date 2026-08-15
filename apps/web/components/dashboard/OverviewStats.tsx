'use client';

import type { DstackInfo, OracleState } from '@/lib/dashboard-types';
import { Activity, ExternalLink, Fingerprint, Radio, ShieldCheck } from 'lucide-react';
import { DEFAULT_PAIRS } from '@/lib/onchain-data';

interface OverviewStatsProps {
  oracleState: OracleState | null;
  dstack: DstackInfo | null;
  configuredSyncedCount: number;
  oracleDomain: string;
  datafeedDomain: string;
  oracleAttestationExplorerUrl: string;
  datafeedAttestationExplorerUrl: string;
}

export function OverviewStats({
  oracleState,
  dstack,
  configuredSyncedCount,
  oracleDomain,
  datafeedDomain,
  oracleAttestationExplorerUrl,
  datafeedAttestationExplorerUrl,
}: OverviewStatsProps) {
  return (
    <div className="grid grid-3 stagger-1">
      <div
        className="card-industrial"
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Radio size={14} color="var(--neo-green)" />
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 800,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              ORACLE REGISTRY
            </span>
          </div>
          <div className="status-dot"></div>
        </div>
        <div>
          <div
            style={{
              fontSize: '1.25rem',
              fontWeight: 800,
              fontFamily: 'var(--font-mono)',
              letterSpacing: 0,
            }}
          >
            {oracleState?.request_fee_display || '0.01 GAS'}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
            {oracleState?.domain || oracleDomain || 'NNS not configured'}
          </div>
        </div>
      </div>

      <div
        className="card-industrial"
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={14} color="var(--accent-purple)" />
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 800,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              TEE STATUS
            </span>
          </div>
          <Fingerprint size={14} color="var(--neo-green)" />
        </div>
        <div>
          <div
            style={{
              fontSize: '1.05rem',
              fontWeight: 800,
              fontFamily: 'var(--font-mono)',
              letterSpacing: 0,
            }}
          >
            {dstack?.app_id ? 'Attested' : 'Unavailable'}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
            {dstack?.client_kind || 'dstack'}{' '}
            {dstack?.compose_hash ? `· ${String(dstack.compose_hash).slice(0, 12)}...` : ''}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              marginTop: '0.75rem',
              fontSize: '0.72rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {oracleAttestationExplorerUrl ? (
              <a
                href={oracleAttestationExplorerUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  color: 'var(--neo-green)',
                  textDecoration: 'none',
                }}
              >
                Oracle CVM
                <ExternalLink size={12} />
              </a>
            ) : null}
            {datafeedAttestationExplorerUrl ? (
              <a
                href={datafeedAttestationExplorerUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  color: 'var(--accent-blue)',
                  textDecoration: 'none',
                }}
              >
                Datafeed CVM
                <ExternalLink size={12} />
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className="card-industrial"
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Activity size={14} color="var(--accent-blue)" />
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 800,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              FEED AUTOMATION
            </span>
          </div>
          <span
            style={{
              fontSize: '0.65rem',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
            }}
          >
            60s / 0.1%
          </span>
        </div>
        <div>
          <div
            style={{
              fontSize: '1.25rem',
              fontWeight: 800,
              fontFamily: 'var(--font-mono)',
              letterSpacing: 0,
            }}
          >
            {configuredSyncedCount} Synced / {DEFAULT_PAIRS.length} Configured
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
            NNS: {datafeedDomain || 'not configured'}
          </div>
        </div>
      </div>
    </div>
  );
}
