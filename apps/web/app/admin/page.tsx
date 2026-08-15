'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ProviderConfigPanel } from '../../components/provider-config-panel';
import { RelayerOpsPanel } from '../../components/relayer-ops-panel';
import { AlertTriangle, ArrowLeft } from 'lucide-react';

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState('providers');

  return (
    <>
      <div className="container" style={{ padding: 'calc(72px + 2rem) 0' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '2rem',
          }}
        >
          <AlertTriangle size={20} color="var(--warning)" />
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 800,
              color: 'var(--warning)',
              letterSpacing: 0,
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
            }}
          >
            Restricted Access
          </span>
        </div>

        <h1
          style={{
            fontSize: '2.5rem',
            fontWeight: 900,
            letterSpacing: 0,
            marginBottom: '1rem',
          }}
        >
          Network Operations
        </h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '1rem',
            marginBottom: '2.5rem',
            maxWidth: '600px',
          }}
        >
          Manage provider configurations, monitor relayer health, and handle dead-letter queues.
          Authorized personnel only.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '240px 1fr',
            gap: '2rem',
          }}
          className="admin-layout"
        >
          <aside>
            <div
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-dim)',
                borderRadius: 'var(--ns-radius-lg)',
                boxShadow: 'var(--ns-shadow-md)',
                padding: '0.5rem',
                position: 'sticky',
                top: '100px',
              }}
            >
              <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {[
                  { id: 'providers', label: 'Provider Configs' },
                  { id: 'relayer', label: 'Relayer Ops' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '0.85rem 1rem',
                      background: activeTab === tab.id ? 'var(--neo-green-dim)' : 'transparent',
                      border: '1px solid',
                      borderColor:
                        activeTab === tab.id ? 'rgba(22, 199, 132, 0.32)' : 'transparent',
                      borderRadius: 'var(--ns-radius-xs)',
                      color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.2s',
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              <div
                style={{
                  marginTop: '1rem',
                  padding: '1rem',
                  borderLeft: '3px solid var(--warning)',
                  background: 'rgba(245, 158, 11, 0.05)',
                }}
              >
                <div
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 800,
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: 0,
                    marginBottom: '0.5rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Security Note
                </div>
                <p
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    lineHeight: 1.6,
                  }}
                >
                  Changes here affect live network nodes and relayer services. Ensure API keys are
                  kept secure.
                </p>
              </div>
            </div>
          </aside>

          <div>
            {activeTab === 'providers' ? (
              <div className="fade-in">
                <ProviderConfigPanel />
              </div>
            ) : (
              <div className="fade-in">
                <RelayerOpsPanel />
              </div>
            )}
          </div>
        </div>
        <div style={{ marginTop: '2rem' }}>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0.5rem 1rem',
              background: 'transparent',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-highlight)',
              borderRadius: 'var(--ns-radius-full)',
              fontSize: '0.75rem',
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back to Home
          </Link>
        </div>
      </div>
    </>
  );
}
