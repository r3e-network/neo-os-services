'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  BookOpen,
  Box,
  CheckCircle2,
  ChevronRight,
  Copy,
  Cpu,
  Database,
  Globe,
  KeyRound,
  Terminal,
  Trash2,
} from 'lucide-react';

import type { ProviderSummary } from '@/lib/dashboard-types';

type DashboardTabId = 'overview' | 'providers' | 'oracle' | 'compute' | 'studio' | 'devhub';
type CopyState = 'idle' | 'copied' | 'failed';

type WorkflowTab = {
  id: DashboardTabId;
  label: string;
  description: string;
  status: string;
  icon: LucideIcon;
};

const WORKFLOW_TABS: WorkflowTab[] = [
  {
    id: 'oracle',
    label: 'Oracle Requests',
    description: 'Encrypt private fields and generate on-chain Oracle.request packages.',
    status: 'NEP-21 ready',
    icon: Box,
  },
  {
    id: 'compute',
    label: 'Private Compute',
    description: 'Author JS/WASM compute payloads and prepare callback verification templates.',
    status: 'TEE payloads',
    icon: Cpu,
  },
  {
    id: 'providers',
    label: 'Data Catalog',
    description: 'Provider adapters, canonical feed keys, pair semantics, and storage units.',
    status: 'Feed catalog',
    icon: Database,
  },
  {
    id: 'studio',
    label: 'Starter Studio',
    description: 'Guided templates for oracle, compute, NeoDID, and developer onboarding.',
    status: 'Templates',
    icon: KeyRound,
  },
  {
    id: 'devhub',
    label: 'Developer Hub',
    description: 'Reference snippets, API entry points, contract flow notes, and handoff material.',
    status: 'Docs',
    icon: BookOpen,
  },
  {
    id: 'overview',
    label: 'Runtime Status',
    description: 'Runtime health, on-chain state, feed synchronization, and attestation anchors.',
    status: 'Reference',
    icon: Globe,
  },
];

const TabFallback = () => (
  <div className="dashboard-loading-panel" role="status" aria-live="polite">
    <div className="status-dot" />
    <p>Loading workspace...</p>
  </div>
);

const OverviewTab = dynamic(
  () => import('./dashboard/OverviewTab').then((mod) => mod.OverviewTab),
  { loading: () => <TabFallback /> }
);
const OracleTab = dynamic(() => import('./dashboard/OracleTab').then((mod) => mod.OracleTab), {
  loading: () => <TabFallback />,
});
const ComputeTab = dynamic(() => import('./dashboard/ComputeTab').then((mod) => mod.ComputeTab), {
  loading: () => <TabFallback />,
});
const ProvidersTab = dynamic(
  () => import('./dashboard/ProvidersTab').then((mod) => mod.ProvidersTab),
  { loading: () => <TabFallback /> }
);
const DeveloperHub = dynamic(
  () => import('./dashboard/DeveloperHub').then((mod) => mod.DeveloperHub),
  { loading: () => <TabFallback /> }
);
const StarterStudio = dynamic(
  () => import('./starter/StarterStudio').then((mod) => mod.StarterStudio),
  { loading: () => <TabFallback /> }
);

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<DashboardTabId>('oracle');
  const [output, setOutput] = useState<string>('');
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [isProvidersLoading, setIsProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providerRetryKey, setProviderRetryKey] = useState(0);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (activeTab !== 'providers' || providers.length > 0) {
      return;
    }

    let cancelled = false;
    (async () => {
      setIsProvidersLoading(true);
      setProvidersError(null);
      try {
        const providersRes = await fetch('/api/providers');
        const providersBody = await providersRes.json().catch(() => ({}));
        if (!providersRes.ok) {
          throw new Error(`Provider API returned ${providersRes.status}`);
        }
        if (!cancelled && Array.isArray(providersBody.providers)) {
          setProviders(providersBody.providers);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          setProvidersError(message);
          setOutput(`Provider catalog failed to load: ${message}`);
        }
      } finally {
        if (!cancelled) {
          setIsProvidersLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTab, providerRetryKey, providers.length]);

  useEffect(() => {
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    };
  }, []);

  const activeWorkflow = useMemo(
    () => WORKFLOW_TABS.find((tab) => tab.id === activeTab) ?? WORKFLOW_TABS[0],
    [activeTab]
  );

  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopyState('idle'), 2000);
  };

  const outputMessage =
    output ||
    [
      'NeoOS workbench is ready.',
      'Run an oracle, compute, catalog, or network workflow to see payloads and status here.',
    ].join('\n');

  return (
    <div className="dashboard-shell fade-in">
      <aside className="dashboard-sidebar" aria-label="Workbench workflows">
        <div className="dashboard-sidebar-header">
          <span>Workbench</span>
          <strong>Focus flow</strong>
        </div>
        <nav className="dashboard-tab-list">
          {WORKFLOW_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`dashboard-tab-button${isActive ? ' dashboard-tab-button--active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={17} />
                <span>
                  <strong>{tab.label}</strong>
                  <small>{tab.status}</small>
                </span>
                {isActive && <ChevronRight size={15} aria-hidden="true" />}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="dashboard-main" aria-label={`${activeWorkflow.label} workspace`}>
        {isProvidersLoading && activeTab === 'providers' ? (
          <TabFallback />
        ) : providersError && activeTab === 'providers' ? (
          <div className="dashboard-loading-panel dashboard-loading-panel--error" role="alert">
            <p>Provider catalog unavailable: {providersError}</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setProvidersError(null);
                setProviderRetryKey((value) => value + 1);
              }}
            >
              Retry provider load
            </button>
          </div>
        ) : (
          <div className="fade-in">
            {activeTab === 'overview' && <OverviewTab setOutput={setOutput} />}
            {activeTab === 'providers' && <ProvidersTab providers={providers} />}
            {activeTab === 'oracle' && <OracleTab providers={providers} setOutput={setOutput} />}
            {activeTab === 'compute' && <ComputeTab setOutput={setOutput} />}
            {activeTab === 'studio' && <StarterStudio embedded />}
            {activeTab === 'devhub' && <DeveloperHub />}
          </div>
        )}
      </div>

      <aside className="dashboard-right-rail" aria-label="Run status and output">
        <section className="dashboard-rail-card">
          <div className="dashboard-rail-title">
            <CheckCircle2 size={15} />
            Request Preview
          </div>
          <div className="dashboard-summary-list">
            <div>
              <span>Active workflow</span>
              <strong>{activeWorkflow.label}</strong>
            </div>
            <div>
              <span>Provider catalog</span>
              <strong>
                {providersError
                  ? 'Needs retry'
                  : providers.length
                    ? `${providers.length} loaded`
                    : 'On demand'}
              </strong>
            </div>
            <div>
              <span>Submit path</span>
              <strong>NEP-21 wallet ready</strong>
            </div>
          </div>
        </section>

        <section className="dashboard-output-card">
          <div className="dashboard-output-header">
            <div>
              <Terminal size={14} />
              <span>Run Output</span>
            </div>
            <div className="dashboard-output-actions">
              <button
                type="button"
                aria-label="Copy run output"
                title="Copy run output"
                onClick={handleCopy}
                disabled={!output}
              >
                {copyState === 'copied' ? <CheckCircle2 size={14} /> : <Copy size={14} />}
              </button>
              <button
                type="button"
                aria-label="Clear run output"
                title="Clear run output"
                onClick={() => setOutput('')}
                disabled={!output}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          <pre className={copyState === 'failed' ? 'dashboard-output-error' : undefined}>
            {copyState === 'failed'
              ? 'Unable to copy output. Check browser clipboard permissions.\n\n'
              : ''}
            {outputMessage}
          </pre>
        </section>
      </aside>
    </div>
  );
}
