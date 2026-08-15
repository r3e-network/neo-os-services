'use client';

import Link from 'next/link';
import { ArrowRight, Info, ShieldCheck } from 'lucide-react';

export default function NeoDidWeb3AuthLivePage() {
  return (
    <div className="min-h-screen flex flex-col">
      <main className="container" style={{ flex: 1, padding: 'calc(72px + 2rem) 0' }}>
        <div className="grid grid-2" style={{ gap: '1.5rem' }}>
          <section className="card-industrial" style={{ padding: '2rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                marginBottom: '1rem',
              }}
            >
              <ShieldCheck size={18} color="var(--neo-green)" />
              <span
                style={{
                  fontWeight: 800,
                  letterSpacing: 0,
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}
              >
                Launchpad Notice
              </span>
            </div>
            <h1 style={{ marginBottom: '0.75rem' }}>NeoDID Live Studio Moved</h1>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              The embedded Web3Auth live studio is no longer bundled into the oracle web app. This
              keeps the production oracle console narrower and removes an optional client-side auth
              dependency from the public runtime surface.
            </p>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              The canonical live identity workspace now lives with the Abstract Account frontend,
              while this oracle app remains the source of truth for NeoDID docs, resolver flows,
              verifier tooling, and Oracle request composition.
            </p>
          </section>

          <section className="card-industrial" style={{ padding: '2rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                marginBottom: '1rem',
              }}
            >
              <Info size={18} color="var(--neo-green)" />
              <span
                style={{
                  fontWeight: 800,
                  letterSpacing: 0,
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}
              >
                Next Steps
              </span>
            </div>
            <div style={{ display: 'grid', gap: '1rem' }}>
              <Link
                href="/docs/neodid"
                className="card-industrial"
                style={{ padding: '1.25rem', textDecoration: 'none' }}
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                    Read NeoDID Docs
                  </span>
                  <ArrowRight size={18} color="var(--neo-green)" />
                </div>
                <p
                  style={{ color: 'var(--text-secondary)', marginTop: '0.75rem', marginBottom: 0 }}
                >
                  Review the binding, action-ticket, recovery-ticket, DID method, and encrypted
                  payload flow in one place.
                </p>
              </Link>
              <Link
                href="/launchpad/neodid-resolver"
                className="card-industrial"
                style={{ padding: '1.25rem', textDecoration: 'none' }}
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                    Use Resolver
                  </span>
                  <ArrowRight size={18} color="var(--neo-green)" />
                </div>
                <p
                  style={{ color: 'var(--text-secondary)', marginTop: '0.75rem', marginBottom: 0 }}
                >
                  Resolve service, vault, or recovery DID documents without leaving the oracle app.
                </p>
              </Link>
              <a
                href="https://github.com/r3e-network/neo-abstract-account"
                target="_blank"
                rel="noreferrer"
                className="card-industrial"
                style={{ padding: '1.25rem', textDecoration: 'none' }}
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                    AA Frontend Repo
                  </span>
                  <ArrowRight size={18} color="var(--neo-green)" />
                </div>
                <p
                  style={{ color: 'var(--text-secondary)', marginTop: '0.75rem', marginBottom: 0 }}
                >
                  Use the AA frontend workspace for live Web3Auth login and DID-connected recovery
                  flows.
                </p>
              </a>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
