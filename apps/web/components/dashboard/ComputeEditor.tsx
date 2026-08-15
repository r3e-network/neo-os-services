'use client';

import { Code, FileCode } from 'lucide-react';

interface ComputeEditorProps {
  userCode: string;
  setUserCode: (value: string) => void;
  scriptRefJson: string;
  setScriptRefJson: (value: string) => void;
  computeInput: string;
  setComputeInput: (value: string) => void;
  walletCallbackHash: string;
  setWalletCallbackHash: (value: string) => void;
  walletCallbackMethod: string;
  setWalletCallbackMethod: (value: string) => void;
  isSimulating: boolean;
  onExecute: () => void;
  onGeneratePackage: () => void;
}

export function ComputeEditor({
  userCode,
  setUserCode,
  scriptRefJson,
  setScriptRefJson,
  computeInput,
  setComputeInput,
  walletCallbackHash,
  setWalletCallbackHash,
  walletCallbackMethod,
  setWalletCallbackMethod,
  isSimulating,
  onExecute,
  onGeneratePackage,
}: ComputeEditorProps) {
  return (
    <div className="flex flex-col gap-6">
      {/* Code editor */}
      <div className="card-industrial stagger-2" style={{ padding: '0', marginBottom: '2rem' }}>
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
            <Code className="text-neo" size={16} /> Runtime Logic
          </h3>
        </div>
        <div style={{ padding: '1.5rem' }}>
          <textarea
            className="code-editor"
            value={userCode}
            onChange={(e) => setUserCode(e.target.value)}
            aria-label="Runtime logic source"
            style={{
              minHeight: '220px',
              border: 'none',
              background: 'transparent',
              boxShadow: 'none',
              padding: '0',
            }}
          />
          <div
            style={{
              marginTop: '1rem',
              paddingTop: '1rem',
              borderTop: '1px solid var(--border-dim)',
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
              OPTIONAL SCRIPT_REF (OVERRIDES INLINE SCRIPT)
            </div>
            <textarea
              className="code-editor"
              value={scriptRefJson}
              onChange={(e) => setScriptRefJson(e.target.value)}
              aria-label="Optional script_ref JSON"
              style={{
                minHeight: '120px',
                border: 'none',
                background: 'transparent',
                boxShadow: 'none',
                padding: '0',
              }}
            />
          </div>
        </div>
      </div>

      {/* Mock input */}
      <div className="card-industrial stagger-3" style={{ padding: '0' }}>
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
            <FileCode className="text-neo" size={16} /> Test Input and Callback
          </h3>
        </div>
        <div style={{ padding: '1.5rem' }}>
          <div className="grid grid-2" style={{ gap: '1rem', marginBottom: '1rem' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="compute-wallet-callback-hash">
                Wallet / Direct Test Callback Hash
              </label>
              <input
                id="compute-wallet-callback-hash"
                className="neo-input"
                value={walletCallbackHash}
                onChange={(event) => setWalletCallbackHash(event.target.value)}
                placeholder="0x..."
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="compute-callback-method">
                Callback Method
              </label>
              <input
                id="compute-callback-method"
                className="neo-input"
                value={walletCallbackMethod}
                onChange={(event) => setWalletCallbackMethod(event.target.value)}
                placeholder="onOracleResult"
              />
            </div>
          </div>
          <textarea
            className="code-editor"
            value={computeInput}
            onChange={(e) => setComputeInput(e.target.value)}
            style={{
              minHeight: '100px',
              border: 'none',
              background: 'transparent',
              boxShadow: 'none',
              padding: '0',
              marginBottom: '1.5rem',
            }}
          />
          <button
            className="btn-ata"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={onExecute}
            disabled={isSimulating}
          >
            {isSimulating ? 'Checking...' : 'Run Local Authoring Check'}
          </button>
          <button
            className="btn-secondary"
            style={{
              width: '100%',
              justifyContent: 'center',
              marginTop: '0.75rem',
              border: '1px solid var(--border-dim)',
            }}
            onClick={onGeneratePackage}
          >
            Generate On-Chain Compute Package
          </button>
        </div>
      </div>
    </div>
  );
}
