'use client';

import { Cpu, Database, FileCode, Fingerprint, Lock, ShieldAlert, Zap } from 'lucide-react';

interface ComputeTemplate {
  name: string;
  runtime: string;
  desc: string;
  cat: string;
}

interface ComputeFunctionsProps {
  selectedFunc: string;
  onSelectPreset: (name: string) => void;
}

const MOCK_TEMPLATES: ComputeTemplate[] = [
  {
    name: 'script.sum',
    runtime: 'JS',
    desc: 'Custom JS entry point using the actual process(input, helpers) signature.',
    cat: 'Custom JS',
  },
  {
    name: 'script.timestamp',
    runtime: 'JS',
    desc: 'Uses the injected helper set to timestamp results.',
    cat: 'Helpers',
  },
  {
    name: 'script.base64_decode',
    runtime: 'JS',
    desc: 'Uses helpers.base64Decode for deterministic input transforms.',
    cat: 'Helpers',
  },
  {
    name: 'builtin.math.modexp',
    runtime: 'Builtin',
    desc: 'Reference payload shape for modular exponentiation.',
    cat: 'Math',
  },
  {
    name: 'builtin.matrix.multiply',
    runtime: 'Builtin',
    desc: 'Reference payload shape for matrix multiplication.',
    cat: 'Linear Algebra',
  },
  {
    name: 'builtin.privacy.mask',
    runtime: 'Builtin',
    desc: 'Reference payload shape for masking a sensitive string.',
    cat: 'Privacy',
  },
  {
    name: 'builtin.zkp.public_signal_hash',
    runtime: 'Builtin',
    desc: 'Reference payload shape for a ZKP digest helper.',
    cat: 'ZKP',
  },
  {
    name: 'builtin.zkp.groth16.verify',
    runtime: 'Builtin',
    desc: 'Reference payload shape for Groth16 proof verification.',
    cat: 'ZKP',
  },
  {
    name: 'builtin.zkp.zerc20.single_withdraw.verify',
    runtime: 'Builtin',
    desc: 'Reference payload shape for zERC20 single-withdraw proof preflight.',
    cat: 'ZKP',
  },
  {
    name: 'wasm.reference',
    runtime: 'WASM',
    desc: 'Use WASM when you need stronger isolation and a 30s bounded runtime.',
    cat: 'WASM',
  },
];

export function ComputeFunctions({ selectedFunc, onSelectPreset }: ComputeFunctionsProps) {
  return (
    <>
      {/* Quick preset buttons */}
      <div className="card-industrial" style={{ padding: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem' }}>
          <Zap size={18} color="var(--neo-green)" />
          <h3
            style={{
              margin: 0,
              fontSize: '0.95rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Function Presets
          </h3>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
          <button
            className="btn-secondary"
            style={{ border: '1px solid var(--border-dim)' }}
            onClick={() => onSelectPreset('builtin.privacy.mask')}
          >
            <Lock size={14} /> privacy.mask
          </button>
          <button
            className="btn-secondary"
            style={{ border: '1px solid var(--border-dim)' }}
            onClick={() => onSelectPreset('builtin.math.modexp')}
          >
            <Cpu size={14} /> math.modexp
          </button>
          <button
            className="btn-secondary"
            style={{ border: '1px solid var(--border-dim)' }}
            onClick={() => onSelectPreset('builtin.zkp.public_signal_hash')}
          >
            <Database size={14} /> zkp.public_signal_hash
          </button>
          <button
            className="btn-secondary"
            style={{ border: '1px solid var(--border-dim)' }}
            onClick={() => onSelectPreset('builtin.zkp.groth16.verify')}
          >
            <ShieldAlert size={14} /> zkp.groth16.verify
          </button>
          <button
            className="btn-secondary"
            style={{ border: '1px solid var(--border-dim)' }}
            onClick={() => onSelectPreset('builtin.zkp.zerc20.single_withdraw.verify')}
          >
            <ShieldAlert size={14} /> zerc20.verify
          </button>
          <button
            className="btn-secondary"
            style={{ border: '1px solid var(--border-dim)' }}
            onClick={() => onSelectPreset('builtin.matrix.multiply')}
          >
            <Database size={14} /> matrix.multiply
          </button>
          <button
            className="btn-secondary"
            style={{ border: '1px solid var(--border-dim)' }}
            onClick={() => onSelectPreset('wasm.reference')}
          >
            <FileCode size={14} /> wasm.reference
          </button>
        </div>
      </div>

      {/* Full catalog list */}
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
            <Database className="text-neo" size={16} /> Functions Catalog
          </h3>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '600px',
            overflowY: 'auto',
          }}
        >
          {MOCK_TEMPLATES.map((f) => (
            <button
              key={f.name}
              onClick={() => onSelectPreset(f.name)}
              style={{
                width: '100%',
                padding: '1.5rem',
                border: 'none',
                borderBottom: '1px solid var(--border-dim)',
                background: selectedFunc === f.name ? 'rgba(0, 168, 107, 0.09)' : 'transparent',
                color: selectedFunc === f.name ? 'var(--text-primary)' : 'var(--text-secondary)',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'background 0.2s',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  width: '100%',
                  gap: '0.75rem',
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    minWidth: 0,
                    flex: '1 1 auto',
                  }}
                >
                  <Fingerprint
                    size={16}
                    color={selectedFunc === f.name ? 'var(--neo-green)' : 'var(--text-muted)'}
                    style={{ flexShrink: 0, marginTop: '0.1rem' }}
                  />
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: '0.9rem',
                      fontFamily: 'var(--font-mono)',
                      overflowWrap: 'anywhere',
                      wordBreak: 'break-word',
                    }}
                  >
                    {f.name}
                  </span>
                </div>
                <span
                  className="badge-outline"
                  style={{
                    color: 'var(--accent-purple)',
                    borderColor: 'var(--accent-purple)',
                    flexShrink: 0,
                  }}
                >
                  {f.cat}
                </span>
              </div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: selectedFunc === f.name ? 'var(--text-muted)' : 'var(--text-muted)',
                  lineHeight: 1.5,
                }}
              >
                {f.desc}
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
