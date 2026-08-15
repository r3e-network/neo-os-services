import Link from 'next/link';
import { CheckCircle, ArrowRight } from 'lucide-react';
import { Launchpad } from '@/components/launchpad/Launchpad';

export default function DocsLaunchpadPage() {
  return (
    <div className="fade-in">
      <div
        className="card-industrial"
        style={{
          padding: '1.5rem',
          marginBottom: '2rem',
          borderLeft: '4px solid var(--neo-green)',
        }}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '0.75rem' }}
        >
          <CheckCircle size={18} color="var(--neo-green)" />
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 800,
              color: 'var(--neo-green)',
              textTransform: 'uppercase',
              letterSpacing: 0,
              fontFamily: 'var(--font-mono)',
            }}
          >
            AA + Paymaster Validated
          </span>
        </div>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '0.85rem' }}>
          The Morpheus-sponsored AA relay path is already validated on Neo N3 testnet. If your goal
          is sponsored execution, you can follow the same Oracle-to-relay flow with confidence
          instead of treating the paymaster path as experimental.
        </p>
        <p
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.85rem',
            marginBottom: '1rem',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Full-path relay tx: 0x057d4a581efbe815fad0148a3766284da2a33335e72fb50e54d476078d8f40d4
        </p>
        <Link
          href="/docs/r/PAYMASTER"
          className="btn btn-secondary btn-sm"
          style={{ textDecoration: 'none' }}
        >
          Open Paymaster Guide <ArrowRight size={14} />
        </Link>
      </div>
      <Launchpad embedded />
    </div>
  );
}
