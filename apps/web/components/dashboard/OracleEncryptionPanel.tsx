'use client';

import type { OracleKeyMeta } from '@/lib/dashboard-types';
import { Lock } from 'lucide-react';

interface OracleEncryptionPanelProps {
  oracleConfidentialJson: string;
  setOracleConfidentialJson: (value: string) => void;
  keySummary: { algorithm: string; source: string };
  isEncrypting: boolean;
  oracleKeyMeta: OracleKeyMeta | null;
  oracleEncryptedParams: string;
  setOracleEncryptedParams: (value: string) => void;
  onEncryptPatch: () => void;
}

export function OracleEncryptionPanel({
  oracleConfidentialJson,
  setOracleConfidentialJson,
  keySummary,
  isEncrypting,
  oracleKeyMeta,
  oracleEncryptedParams,
  setOracleEncryptedParams,
  onEncryptPatch,
}: OracleEncryptionPanelProps) {
  return (
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
          <Lock className="text-neo" size={16} /> 1. Local Encryption
        </h3>
      </div>

      <div style={{ padding: '1.5rem' }}>
        <div className="form-group" style={{ marginBottom: '1rem' }}>
          <label
            className="form-label"
            htmlFor="oracle-confidential-json"
            style={{ display: 'flex', justifyContent: 'space-between' }}
          >
            <span>Confidential JSON Patch</span>
            <span style={{ color: 'var(--accent-purple)' }}>Browser Only</span>
          </label>
          <textarea
            id="oracle-confidential-json"
            className="code-editor"
            value={oracleConfidentialJson}
            onChange={(event) => setOracleConfidentialJson(event.target.value)}
            style={{ minHeight: '180px' }}
          />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '1rem',
            marginBottom: '1rem',
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
              ALGORITHM
            </div>
            <div
              style={{
                fontSize: '0.78rem',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                wordBreak: 'break-word',
              }}
            >
              {keySummary.algorithm}
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
              KEY SOURCE
            </div>
            <div
              style={{
                fontSize: '0.78rem',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {keySummary.source}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <button
            className="btn-ata"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={onEncryptPatch}
            disabled={isEncrypting || !oracleKeyMeta}
          >
            {isEncrypting ? 'Encrypting...' : 'Encrypt Patch'}
          </button>
          {oracleEncryptedParams && (
            <button
              className="btn-secondary"
              style={{ padding: '0.75rem 1rem', border: '1px solid var(--border-dim)' }}
              onClick={() => setOracleEncryptedParams('')}
            >
              Clear
            </button>
          )}
        </div>

        {oracleEncryptedParams && (
          <div
            style={{
              marginTop: '1rem',
              padding: '1rem',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              borderLeft: '3px solid var(--neo-green)',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <div
              style={{
                fontSize: '0.65rem',
                color: 'var(--text-secondary)',
                fontWeight: 800,
                marginBottom: '0.5rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              ENCRYPTED PARAMS
            </div>
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--neo-green)',
                wordBreak: 'break-all',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {oracleEncryptedParams}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
