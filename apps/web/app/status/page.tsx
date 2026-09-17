'use client';

// NOTE: metadata is exported from layout.tsx for this route since this is a client component.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCcw,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import {
  getPublicRuntimeStatusNotes,
  type PublicRuntimeStatusSnapshot,
} from '@r3e-network/neo-os-services-shared/public-runtime';
import { getServiceProblemDetail } from '@/lib/service-health';

type ServiceStatus = {
  name: string;
  description: string;
  endpoint: string;
  status: 'operational' | 'degraded' | 'down' | 'checking';
  latencyMs: number | null;
  lastChecked: Date | null;
  detail?: string;
  notes?: string[];
};

const SERVICE_CHECKS: Array<{ name: string; description: string; endpoint: string }> = [
  {
    name: 'Web Application',
    description: 'Main frontend and API gateway',
    endpoint: '/api/health',
  },
  {
    name: 'Oracle CVM Runtime',
    description: 'Canonical public runtime contract, health, and topology metadata',
    endpoint: '/api/runtime/status',
  },
  {
    name: 'On-Chain State',
    description: 'Neo N3 contract registry and datafeed state',
    endpoint: '/api/onchain/state?limit=1',
  },
  {
    name: 'Feed Freshness',
    description: 'Configured on-chain feed freshness and staleness alerts',
    endpoint: '/api/feeds/status',
  },
  {
    name: 'Feed Catalog',
    description: 'Available price pair index',
    endpoint: '/api/feeds/catalog',
  },
  {
    name: 'Provider Registry',
    description: 'Built-in data provider adapters',
    endpoint: '/api/providers',
  },
];

const statusColors: Record<string, string> = {
  operational: 'var(--neo-green)',
  degraded: 'var(--warning)',
  down: 'var(--error)',
  checking: 'var(--text-muted)',
};

const statusLabels: Record<string, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  checking: 'Checking...',
};

function isRuntimeStatusSnapshot(value: unknown): value is PublicRuntimeStatusSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return 'runtime' in value && 'catalog' in value;
}

export default function StatusPage() {
  const [services, setServices] = useState<ServiceStatus[]>(
    SERVICE_CHECKS.map((s) => ({
      ...s,
      status: 'checking',
      latencyMs: null,
      lastChecked: null,
    }))
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastFullCheck, setLastFullCheck] = useState<Date | null>(null);

  const checkServices = useCallback(async () => {
    setIsRefreshing(true);

    const results = await Promise.all(
      SERVICE_CHECKS.map(async (service) => {
        const start = performance.now();
        try {
          const response = await fetch(service.endpoint, {
            signal: AbortSignal.timeout(10000),
          });
          const latencyMs = Math.round(performance.now() - start);
          const contentType = response.headers.get('content-type') || '';
          const body = contentType.includes('application/json')
            ? await response.json().catch(() => null)
            : null;
          const runtimeSnapshot = isRuntimeStatusSnapshot(body) ? body : null;

          if (runtimeSnapshot) {
            return {
              ...service,
              status: runtimeSnapshot.runtime.status,
              latencyMs,
              lastChecked: new Date(),
              detail:
                runtimeSnapshot.runtime.status === 'operational'
                  ? undefined
                  : runtimeSnapshot.runtime.health.detail ||
                    runtimeSnapshot.runtime.info.detail ||
                    `HTTP ${response.status}`,
              notes: getPublicRuntimeStatusNotes(runtimeSnapshot),
            };
          }

          // Inspect the body too: routes can answer HTTP 200 while carrying
          // an explicit failure payload (ok:false, error strings).
          const problemDetail = getServiceProblemDetail(body);
          if (response.ok && !problemDetail) {
            return {
              ...service,
              status: 'operational' as const,
              latencyMs,
              lastChecked: new Date(),
            };
          }
          return {
            ...service,
            status: 'degraded' as const,
            latencyMs,
            lastChecked: new Date(),
            detail: problemDetail || `HTTP ${response.status}`,
          };
        } catch (err) {
          const latencyMs = Math.round(performance.now() - start);
          return {
            ...service,
            status: 'down' as const,
            latencyMs,
            lastChecked: new Date(),
            detail: err instanceof Error ? err.message : 'Connection failed',
          };
        }
      })
    );

    setServices(results);
    setLastFullCheck(new Date());
    setIsRefreshing(false);
  }, []);

  useEffect(() => {
    void checkServices();
    // Skip the wall-clock poll while the tab is backgrounded so a hidden status
    // page does not keep firing service probes; refresh once when it returns to
    // the foreground so the readout is current the moment the user looks again.
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void checkServices();
    }, 30000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkServices();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkServices]);

  const overallStatus = services.some((s) => s.status === 'down')
    ? 'down'
    : services.some((s) => s.status === 'degraded')
      ? 'degraded'
      : services.every((s) => s.status === 'operational')
        ? 'operational'
        : 'checking';

  const OverallIcon =
    overallStatus === 'operational'
      ? CheckCircle2
      : overallStatus === 'degraded'
        ? AlertTriangle
        : overallStatus === 'down'
          ? XCircle
          : Activity;

  const overallMessages: Record<string, string> = {
    operational: 'All systems operational',
    degraded: 'Some services experiencing issues',
    down: 'Service disruption detected',
    checking: 'Checking service status...',
  };

  return (
    <div
      className="container oracle-tool-page"
      style={{ paddingTop: 'calc(72px + 1.5rem)', paddingBottom: '4rem' }}
    >
      <div className="fade-in oracle-tool-hero">
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '1rem',
          }}
        >
          <Activity size={14} color="var(--neo-green)" />
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 800,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0,
              fontFamily: 'var(--font-mono)',
            }}
          >
            SERVICE STATUS
          </span>
        </div>
        <h1
          style={{
            fontSize: 'clamp(2rem, 4vw, 3rem)',
            fontWeight: 800,
            letterSpacing: 0,
            marginBottom: '0.75rem',
          }}
        >
          System Status
        </h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            maxWidth: '640px',
            fontSize: '1rem',
            lineHeight: 1.7,
            marginBottom: '1.25rem',
          }}
        >
          Real-time health checks for NeoOS Oracle infrastructure services and the public runtime
          contract that exposes topology, risk, and automation metadata. This page auto-refreshes
          every 30 seconds.
        </p>
      </div>

      <Card
        className="oracle-tool-card"
        style={{
          marginBottom: '1.25rem',
          borderLeft: `4px solid ${statusColors[overallStatus]}`,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <OverallIcon size={28} color={statusColors[overallStatus]} />
            <div>
              <div
                style={{
                  fontSize: '1.25rem',
                  fontWeight: 800,
                  color: statusColors[overallStatus],
                }}
              >
                {overallMessages[overallStatus]}
              </div>
              {lastFullCheck && (
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    marginTop: '4px',
                  }}
                >
                  Last checked: {lastFullCheck.toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={() => void checkServices()}
            disabled={isRefreshing}
            aria-label="Refresh service status"
            style={{
              background: 'transparent',
              border: '1px solid var(--border-highlight)',
              borderRadius: 'var(--ns-radius-full)',
              color: 'var(--text-secondary)',
              cursor: isRefreshing ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '0.6rem 1.2rem',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0,
              transition: 'all 0.2s',
              opacity: isRefreshing ? 0.5 : 1,
            }}
          >
            <RefreshCcw
              size={14}
              style={{
                animation: isRefreshing ? 'spin 1s linear infinite' : 'none',
              }}
            />
            {isRefreshing ? 'CHECKING...' : 'REFRESH'}
          </button>
        </div>
      </Card>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', marginBottom: '2.5rem' }}>
        {services.map((service, index) => {
          const StatusIcon =
            service.status === 'operational'
              ? CheckCircle2
              : service.status === 'degraded'
                ? AlertTriangle
                : service.status === 'down'
                  ? XCircle
                  : Clock;
          const color = statusColors[service.status];
          const isFirst = index === 0;
          const isLast = index === services.length - 1;

          return (
            <div
              key={service.name}
              className="card-industrial"
              style={{
                padding: '1.25rem 1.5rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderRadius: 0,
                borderTopLeftRadius: isFirst ? 'var(--ns-radius-lg)' : 0,
                borderTopRightRadius: isFirst ? 'var(--ns-radius-lg)' : 0,
                borderBottomLeftRadius: isLast ? 'var(--ns-radius-lg)' : 0,
                borderBottomRightRadius: isLast ? 'var(--ns-radius-lg)' : 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1 }}>
                <StatusIcon size={18} color={color} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{service.name}</div>
                  <div
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--text-secondary)',
                      marginTop: '2px',
                    }}
                  >
                    {service.description}
                  </div>
                  {service.notes?.map((note) => (
                    <div
                      key={note}
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                        marginTop: '4px',
                      }}
                    >
                      {note}
                    </div>
                  ))}
                  {service.detail && service.status !== 'operational' && (
                    <div
                      style={{
                        fontSize: '0.72rem',
                        color: color,
                        fontFamily: 'var(--font-mono)',
                        marginTop: '4px',
                      }}
                    >
                      {service.detail}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexShrink: 0 }}>
                {service.latencyMs !== null && (
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {service.latencyMs}ms
                  </span>
                )}
                <span
                  className="badge-outline"
                  style={{
                    color,
                    borderColor: color,
                    minWidth: '90px',
                    textAlign: 'center',
                  }}
                >
                  {statusLabels[service.status]}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <Link
          href="/explorer"
          className="btn-secondary"
          style={{
            padding: '0.85rem 1.5rem',
            textTransform: 'uppercase',
            fontSize: '0.8rem',
            letterSpacing: 0,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <Activity size={14} />
          Explorer
        </Link>
        <a
          href="https://github.com/r3e-network/neo-os-services/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary"
          style={{
            padding: '0.85rem 1.5rem',
            textTransform: 'uppercase',
            fontSize: '0.8rem',
            letterSpacing: 0,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <ExternalLink size={14} />
          Report Issue
        </a>
      </div>
    </div>
  );
}
