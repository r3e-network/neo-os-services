import Link from 'next/link';
import { Activity, ArrowRight, CheckCircle2, KeyRound } from 'lucide-react';

import { Dashboard } from '@/components/dashboard';
import { getSelectedNetwork, getSelectedNetworkKey } from '@/lib/networks';

const validationItems = [
  'Local encryption before payload submission',
  'On-chain Oracle.request package generation',
  'NEP-21 wallet path for direct testnet requests',
  'Callback readback and verifier templates',
];

type HomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstSearchValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getNetworkSummary(networkOverride?: string) {
  const key = getSelectedNetworkKey(networkOverride);
  const network = getSelectedNetwork(key);
  const environmentLabel = key === 'mainnet' ? 'Mainnet' : 'Testnet';

  return {
    key,
    name: network.network === 'mainnet' ? 'Neo N3 Mainnet' : 'Neo N3 Testnet',
    environmentLabel,
    oracle: network.neo_n3?.contracts?.morpheus_oracle || '',
  };
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const network = getNetworkSummary(firstSearchValue(resolvedSearchParams.network));
  const networkQuery = `?network=${network.key}`;

  return (
    <div className="workbench-home">
      <section className="workbench-focus-band">
        <div className="container">
          <div className="workbench-focus-grid">
            <div className="workbench-hero-copy">
              <img
                src="/brand/neo-mascot.svg"
                alt=""
                aria-hidden
                width={112}
                height={112}
                style={{ marginBottom: '0.85rem', display: 'block' }}
              />
              <h1>NeoOS Oracle Workbench</h1>
              <p>
                Start with an oracle request, encrypt private fields locally, preview the callback,
                and submit through the Neo N3 wallet path.
              </p>
              <div className="workbench-hero-actions" aria-label="Primary workbench actions">
                <a href="#oracle-workbench" className="btn-ata">
                  Compose Request <ArrowRight size={16} />
                </a>
                <Link
                  href={`/docs/api-reference${networkQuery}`}
                  className="btn-secondary workbench-link-button"
                >
                  API Reference
                </Link>
              </div>
            </div>

            <aside className="workbench-status-panel" aria-label="Deployment reference">
              <div className="workbench-status-header">
                <div>
                  <strong>{network.name}</strong>
                  <span>{network.environmentLabel}</span>
                </div>
                <span className="workbench-status-pill">
                  <Activity size={13} />
                  Ready
                </span>
              </div>
              <details className="workbench-reference-details">
                <summary>Deployment reference</summary>
                <div className="workbench-validation-list">
                  {validationItems.map((item) => (
                    <div key={item} className="workbench-validation-row">
                      <CheckCircle2 size={16} />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </details>
              <div className="workbench-contract-strip">
                <span>Oracle contract</span>
                <code>{network.oracle || 'Not configured'}</code>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section
        id="oracle-workbench"
        className="workbench-dashboard-section"
        aria-label="Morpheus operator workbench"
      >
        <div className="container">
          <Dashboard />
        </div>
      </section>

      <section className="workbench-support-section">
        <div className="container workbench-support-grid">
          <Link href={`/verifier${networkQuery}`} className="workbench-support-link">
            <KeyRound size={18} />
            <span>
              <strong>Verifier</strong>
              <small>Check result envelopes and attestation hashes.</small>
            </span>
          </Link>
          <Link href={`/status${networkQuery}`} className="workbench-support-link">
            <Activity size={18} />
            <span>
              <strong>Runtime Status</strong>
              <small>Inspect public health and runtime catalog metadata.</small>
            </span>
          </Link>
          <Link href={`/launchpad${networkQuery}`} className="workbench-support-link">
            <ArrowRight size={18} />
            <span>
              <strong>Launchpad</strong>
              <small>Start from curated oracle, compute, and NeoDID flows.</small>
            </span>
          </Link>
        </div>
      </section>
    </div>
  );
}
