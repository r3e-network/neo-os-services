'use client';

export type PresetId =
  | 'oracle_quote'
  | 'oracle_private_api'
  | 'oracle_boolean'
  | 'compute_mask'
  | 'compute_modexp';

type PresetBarProps = {
  onApplyPreset: (preset: PresetId) => void;
};

export function PresetBar({ onApplyPreset }: PresetBarProps) {
  return (
    <div
      className="card-industrial"
      style={{
        padding: '1.25rem 1.5rem',
        borderLeft: '4px solid var(--neo-green)',
        marginBottom: '2rem',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
        <button
          className="btn-secondary"
          style={{ border: '1px solid var(--border-dim)' }}
          onClick={() => onApplyPreset('oracle_quote')}
        >
          Preset: Public Quote
        </button>
        <button
          className="btn-secondary"
          style={{ border: '1px solid var(--border-dim)' }}
          onClick={() => onApplyPreset('oracle_private_api')}
        >
          Preset: Private API
        </button>
        <button
          className="btn-secondary"
          style={{ border: '1px solid var(--border-dim)' }}
          onClick={() => onApplyPreset('oracle_boolean')}
        >
          Preset: Boolean Check
        </button>
        <button
          className="btn-secondary"
          style={{ border: '1px solid var(--border-dim)' }}
          onClick={() => onApplyPreset('compute_mask')}
        >
          Preset: privacy.mask
        </button>
        <button
          className="btn-secondary"
          style={{ border: '1px solid var(--border-dim)' }}
          onClick={() => onApplyPreset('compute_modexp')}
        >
          Preset: Encrypted modexp
        </button>
      </div>
    </div>
  );
}
