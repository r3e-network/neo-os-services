'use client';

import { useCallback, useEffect, useState } from 'react';

type RelayerRun = {
  id: string;
  network: string;
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  metrics?: Record<string, unknown> | null;
  checkpoints?: Record<string, unknown> | null;
  runtime?: Record<string, unknown> | null;
  created_at?: string | null;
};

type RelayerJob = {
  id: string;
  event_key: string;
  chain: string;
  request_id: string;
  request_type: string;
  status: string;
  attempts: number;
  last_error?: string | null;
  updated_at?: string | null;
  next_retry_at?: string | null;
};

async function callJSON(path: string, adminApiKey: string, method = 'GET', body?: unknown) {
  const headers = new Headers();
  if (adminApiKey) headers.set('x-admin-api-key', adminApiKey);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: response.status };
  }
}

export function RelayerOpsPanel() {
  const [adminApiKey, setAdminApiKey] = useState('');
  const [latestRun, setLatestRun] = useState<RelayerRun | null>(null);
  const [recentJobs, setRecentJobs] = useState<RelayerJob[]>([]);
  const [deadLetters, setDeadLetters] = useState<RelayerJob[]>([]);
  const [selectedEventKey, setSelectedEventKey] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const hasAdminKey = adminApiKey.trim().length > 0;
  const hasSelectedEventKey = selectedEventKey.trim().length > 0;

  const refresh = useCallback(async (currentKey: string) => {
    setIsLoading(true);
    try {
      const [metricsBody, jobsBody, deadLettersBody] = await Promise.all([
        callJSON('/api/relayer/metrics?limit=5', currentKey),
        callJSON('/api/relayer/jobs?limit=10', currentKey),
        callJSON('/api/relayer/dead-letters?limit=10', currentKey),
      ]);

      setLatestRun(metricsBody.latest || null);
      setRecentJobs(Array.isArray(jobsBody.jobs) ? jobsBody.jobs : []);
      setDeadLetters(
        Array.isArray(deadLettersBody.dead_letters) ? deadLettersBody.dead_letters : []
      );

      const error = metricsBody.error || jobsBody.error || deadLettersBody.error;
      if (error) setMessage(JSON.stringify({ error }, null, 2));
    } finally {
      setIsLoading(false);
    }
  }, []);

  async function runAction(path: string, eventKey: string) {
    const normalizedEventKey = eventKey.trim();
    if (!adminApiKey.trim()) {
      setMessage(
        JSON.stringify(
          { error: 'Relayer admin key is required before running an action.' },
          null,
          2
        )
      );
      return;
    }
    if (!normalizedEventKey) {
      setMessage(
        JSON.stringify({ error: 'Select or enter an event key before running an action.' }, null, 2)
      );
      return;
    }
    const body = await callJSON(path, adminApiKey.trim(), 'POST', {
      event_key: normalizedEventKey,
    });
    setMessage(JSON.stringify(body, null, 2));
    if (!body.error) {
      setSelectedEventKey(normalizedEventKey);
      await refresh(adminApiKey);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedKey = window.sessionStorage.getItem('morpheus.relayerAdminApiKey') || '';
    setAdminApiKey(savedKey);
    refresh(savedKey).catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (adminApiKey) {
      window.sessionStorage.setItem('morpheus.relayerAdminApiKey', adminApiKey);
    } else {
      window.sessionStorage.removeItem('morpheus.relayerAdminApiKey');
    }
  }, [adminApiKey]);

  return (
    <div className="card">
      <h3 className="card-title">Relayer Operations</h3>
      <p className="card-description">
        Monitor relayer health, inspect recent execution jobs, and manage dead-letter queues.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div className="grid grid-2">
          <div className="form-group">
            <label className="form-label" htmlFor="relayer-admin-key">
              Relayer Admin Key
            </label>
            <input
              id="relayer-admin-key"
              className="neo-input"
              type="password"
              value={adminApiKey}
              onChange={(event) => setAdminApiKey(event.target.value)}
              placeholder="••••••••••••••••"
              aria-describedby="relayer-admin-key-help"
            />
            <p
              id="relayer-admin-key-help"
              className="text-xs text-dim"
              style={{ marginTop: '0.5rem' }}
            >
              Required for retry, replay, and dead-letter operations.
            </p>
          </div>
          <div className="form-group" style={{ justifyContent: 'flex-end', display: 'flex' }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={isLoading}
              onClick={() =>
                refresh(adminApiKey).catch((error) =>
                  setMessage(JSON.stringify({ error: String(error) }, null, 2))
                )
              }
            >
              {isLoading ? 'Refreshing...' : 'Sync Relayer State'}
            </button>
          </div>
        </div>

        <div className="grid grid-3" style={{ alignItems: 'stretch' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h4 className="text-sm font-bold uppercase text-muted">Latest Snapshot</h4>
            <div className="terminal-panel" style={{ height: '100%', margin: 0 }}>
              <div className="terminal-body" style={{ maxHeight: '300px' }}>
                <pre className="terminal-pre" style={{ fontSize: '0.75rem' }}>
                  {latestRun ? JSON.stringify(latestRun, null, 2) : 'No run snapshot yet.'}
                </pre>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h4 className="text-sm font-bold uppercase text-muted">Recent Jobs</h4>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                maxHeight: '400px',
                overflowY: 'auto',
              }}
            >
              {recentJobs.length === 0 && <p className="text-xs text-dim">No recent jobs found.</p>}
              {recentJobs.map((job) => (
                <div
                  key={job.id}
                  className="card"
                  style={{ padding: '1rem', background: 'var(--bg-surface)' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <span className="badge badge-success text-xs">{job.status}</span>
                    <span className="text-xs text-muted">{job.chain}</span>
                  </div>
                  <div
                    className="text-xs font-mono"
                    style={{ marginBottom: '0.5rem', wordBreak: 'break-all' }}
                  >
                    {job.event_key}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-outline btn-xs"
                      style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                      disabled={!hasAdminKey || isLoading}
                      onClick={() => runAction('/api/relayer/jobs/retry', job.event_key)}
                    >
                      Retry
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                      onClick={() => {
                        setSelectedEventKey(job.event_key);
                        setMessage(JSON.stringify(job, null, 2));
                      }}
                    >
                      Details
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h4 className="text-sm font-bold uppercase text-muted">Dead Letters</h4>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                maxHeight: '400px',
                overflowY: 'auto',
              }}
            >
              {deadLetters.length === 0 && <p className="text-xs text-dim">Queue is empty.</p>}
              {deadLetters.map((job) => (
                <div
                  key={job.id}
                  className="card"
                  style={{
                    padding: '1rem',
                    background: 'rgba(239, 68, 68, 0.05)',
                    borderColor: 'rgba(239, 68, 68, 0.2)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <span className="badge badge-error text-xs">FAILED</span>
                    <span className="text-xs text-muted">{job.chain}</span>
                  </div>
                  <div
                    className="text-xs font-mono"
                    style={{ marginBottom: '0.5rem', wordBreak: 'break-all' }}
                  >
                    {job.event_key}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-primary btn-xs"
                      style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                      disabled={!hasAdminKey || isLoading}
                      onClick={() => runAction('/api/relayer/jobs/replay', job.event_key)}
                    >
                      Replay
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                      onClick={() => {
                        setSelectedEventKey(job.event_key);
                        setMessage(JSON.stringify(job, null, 2));
                      }}
                    >
                      Details
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="terminal-panel">
          <div className="terminal-header">
            <div className="terminal-title">Relayer Command Output</div>
          </div>
          <div className="terminal-body">
            <pre className="terminal-pre">{message || 'Awaiting action...'}</pre>
          </div>
        </div>

        <div className="card" style={{ background: 'var(--bg-surface)', padding: '1.5rem' }}>
          <h4 className="text-sm font-bold uppercase mb-4">Manual Control</h4>
          <div className="grid grid-3" style={{ alignItems: 'flex-end', gap: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="relayer-event-key">
                Event Key
              </label>
              <input
                id="relayer-event-key"
                className="neo-input"
                value={selectedEventKey}
                onChange={(event) => setSelectedEventKey(event.target.value)}
                placeholder="0x..."
                aria-describedby="relayer-event-key-help"
              />
              <p
                id="relayer-event-key-help"
                className="text-xs text-dim"
                style={{ marginTop: '0.5rem' }}
              >
                Pick a job above or paste the exact event key.
              </p>
            </div>
            <button
              className="btn btn-outline"
              disabled={!hasAdminKey || !hasSelectedEventKey || isLoading}
              onClick={() => runAction('/api/relayer/jobs/retry', selectedEventKey)}
            >
              Retry Job
            </button>
            <button
              className="btn btn-outline"
              disabled={!hasAdminKey || !hasSelectedEventKey || isLoading}
              onClick={() => runAction('/api/relayer/jobs/replay', selectedEventKey)}
            >
              Replay DL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
