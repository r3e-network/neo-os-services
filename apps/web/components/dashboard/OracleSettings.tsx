'use client';

import { Cpu, Lock, Shield, Zap } from 'lucide-react';

type OraclePreset = 'public_quote' | 'private_api' | 'boolean_check' | 'hidden_builtin';

interface OracleSettingsProps {
  onApplyPreset: (preset: OraclePreset) => void;
}

export function OracleSettings({ onApplyPreset }: OracleSettingsProps) {
  return (
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
          Request Presets
        </h3>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
        <button
          className="btn-secondary"
          style={{ border: '1px solid var(--border-dim)' }}
          onClick={() => onApplyPreset('public_quote')}
        >
          <Shield size={14} /> Public Quote
        </button>
        <button
          className="btn-secondary"
          style={{ border: '1px solid var(--border-dim)' }}
          onClick={() => onApplyPreset('private_api')}
        >
          <Lock size={14} /> Private API
        </button>
        <button
          className="btn-secondary"
          style={{ border: '1px solid var(--border-dim)' }}
          onClick={() => onApplyPreset('boolean_check')}
        >
          <Cpu size={14} /> Boolean Check
        </button>
        <button
          className="btn-secondary"
          style={{ border: '1px solid var(--border-dim)' }}
          onClick={() => onApplyPreset('hidden_builtin')}
        >
          <Lock size={14} /> Hidden Built-in Params
        </button>
      </div>
    </div>
  );
}
