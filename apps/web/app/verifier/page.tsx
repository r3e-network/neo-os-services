'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, ClipboardList, FileSearch, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyStateArt } from '@/components/illustrations';

async function requestJSON(path: string, body?: Record<string, unknown>) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: response.status };
  }
}

function isValidLookupHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

function VerifierPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialLookupHash = searchParams.get('attestation_hash') || '';
  const [attestationJson, setAttestationJson] = useState('{}');
  const [expectedPayloadJson, setExpectedPayloadJson] = useState('{}');
  const [expectedOutputHash, setExpectedOutputHash] = useState('');
  const [expectedAttestationHash, setExpectedAttestationHash] = useState('');
  const [expectedComposeHash, setExpectedComposeHash] = useState('');
  const [expectedAppId, setExpectedAppId] = useState('');
  const [expectedInstanceId, setExpectedInstanceId] = useState('');
  const [result, setResult] = useState<string>('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [lookupHash, setLookupHash] = useState(initialLookupHash);
  const [isLookingUp, setIsLookuping] = useState(false);

  const normalizedLookupHash = useMemo(() => lookupHash.trim(), [lookupHash]);

  const runVerification = useCallback(
    async (params: {
      attestation: unknown;
      expectedPayload?: unknown;
      expectedOutputHash?: string;
      expectedAttestationHash?: string;
      expectedComposeHash?: string;
      expectedAppId?: string;
      expectedInstanceId?: string;
    }) => {
      const body = await requestJSON('/api/attestation/verify', {
        envelope: params.attestation,
        attestation: params.attestation,
        expected_payload: params.expectedPayload,
        expected_output_hash: params.expectedOutputHash || undefined,
        expected_attestation_hash: params.expectedAttestationHash || undefined,
        expected_onchain_attestation_hash: params.expectedAttestationHash || undefined,
        expected_compose_hash: params.expectedComposeHash || undefined,
        expected_app_id: params.expectedAppId || undefined,
        expected_instance_id: params.expectedInstanceId || undefined,
      });
      return body;
    },
    []
  );

  const lookupAttestation = useCallback(
    async (hash: string, updateUrl = true) => {
      const value = hash.trim();
      if (!value) return;
      if (!isValidLookupHash(value)) {
        setExpectedAttestationHash(value);
        setResult(
          JSON.stringify(
            {
              error: 'Invalid attestation hash',
              detail: 'Use a 0x-prefixed 32-byte hash before lookup.',
            },
            null,
            2
          )
        );
        return;
      }

      if (updateUrl) {
        router.replace(`/verifier?attestation_hash=${encodeURIComponent(value)}`);
      }

      setIsLookuping(true);
      try {
        const body = await requestJSON(
          `/api/attestation/lookup?attestation_hash=${encodeURIComponent(value)}`
        );
        if ((body as { error?: string }).error && !(body as { found?: boolean }).found) {
          setResult(JSON.stringify(body, null, 2));
          return;
        }

        const verifierInput =
          (body as { verifier_input?: Record<string, unknown> | null }).verifier_input || null;
        if (!verifierInput) {
          setExpectedAttestationHash(value);
          setResult(JSON.stringify(body, null, 2));
          return;
        }

        setAttestationJson(
          JSON.stringify(verifierInput.envelope || verifierInput.attestation || {}, null, 2)
        );
        setExpectedOutputHash(String(verifierInput.expected_output_hash || ''));
        setExpectedAttestationHash(String(verifierInput.expected_attestation_hash || value));
        setExpectedComposeHash(String(verifierInput.expected_compose_hash || ''));
        setExpectedAppId(String(verifierInput.expected_app_id || ''));
        setExpectedInstanceId(String(verifierInput.expected_instance_id || ''));

        const verification = await runVerification({
          attestation: verifierInput.envelope || verifierInput.attestation || {},
          expectedOutputHash: String(verifierInput.expected_output_hash || ''),
          expectedAttestationHash: String(verifierInput.expected_attestation_hash || value),
          expectedComposeHash: String(verifierInput.expected_compose_hash || ''),
          expectedAppId: String(verifierInput.expected_app_id || ''),
          expectedInstanceId: String(verifierInput.expected_instance_id || ''),
        });

        setResult(JSON.stringify({ lookup: body, verification }, null, 2));
      } catch (error) {
        setResult(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)
        );
      } finally {
        setIsLookuping(false);
      }
    },
    [router, runVerification]
  );

  useEffect(() => {
    if (!initialLookupHash) return;
    setLookupHash(initialLookupHash);
    void lookupAttestation(initialLookupHash, false);
  }, [initialLookupHash, lookupAttestation]);

  return (
    <>
      <div
        className="container oracle-tool-page"
        style={{ padding: 'calc(72px + 1.25rem) 0 3rem' }}
      >
        <Card
          className="oracle-tool-hero-card"
          style={{ marginBottom: '1.25rem', borderLeft: '4px solid var(--neo-green)' }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: '2rem',
            }}
          >
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '0.75rem',
                }}
              >
                <ShieldCheck size={16} color="var(--neo-green)" />
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 800,
                    color: 'var(--neo-green)',
                    letterSpacing: 0,
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                  }}
                >
                  TEE Verification
                </span>
              </div>
              <h1
                style={{
                  fontSize: '2rem',
                  fontWeight: 900,
                  letterSpacing: 0,
                  marginBottom: '0.5rem',
                }}
              >
                Attestation Verifier
              </h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Paste a worker response, on-chain callback envelope, or raw TEE attestation JSON and
                verify hash binding, report-data prefix, compose hash, app id, and instance id.
              </p>
            </div>
            <ShieldCheck size={48} color="var(--neo-green)" />
          </div>
        </Card>

        <Card className="oracle-tool-card" style={{ marginBottom: '1rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>
                Lookup By Attestation Hash
              </h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                Open with <code>?attestation_hash=0x...</code> or paste a hash below.
              </p>
            </div>
            <FileSearch size={20} color="var(--neo-green)" />
          </div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="neo-input"
              value={lookupHash}
              onChange={(event) => setLookupHash(event.target.value)}
              placeholder="0x attestation hash"
              aria-label="Attestation hash"
              style={{ flex: 1, minWidth: '200px' }}
            />
            <button
              className="btn-ata"
              disabled={isLookingUp || !normalizedLookupHash}
              onClick={() => {
                void lookupAttestation(normalizedLookupHash, true);
              }}
              style={{ whiteSpace: 'nowrap' }}
            >
              {isLookingUp ? 'Querying...' : 'Lookup'}
            </button>
          </div>
        </Card>

        <div className="grid grid-2 oracle-tool-grid" style={{ gap: '1rem', marginBottom: '1rem' }}>
          <Card className="oracle-tool-card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1rem',
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>
                  Worker / Callback / Attestation JSON
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                  Paste a full worker response or raw tee_attestation object.
                </p>
              </div>
              <ClipboardList size={20} color="var(--neo-green)" />
            </div>
            <textarea
              className="code-editor"
              value={attestationJson}
              onChange={(event) => setAttestationJson(event.target.value)}
              style={{ minHeight: '300px' }}
              placeholder='{ "verification": { "attestation_hash": "...", "tee_attestation": { ... } } }'
            />
          </Card>

          <Card className="oracle-tool-card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1rem',
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>
                  Verification Inputs
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                  Optional expectations for stronger verification.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <label
                  htmlFor="expected-payload"
                  className="form-label"
                  style={{
                    display: 'block',
                    marginBottom: '0.35rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Expected Payload
                </label>
                <textarea
                  id="expected-payload"
                  className="code-editor"
                  value={expectedPayloadJson}
                  onChange={(event) => setExpectedPayloadJson(event.target.value)}
                  style={{ minHeight: '80px' }}
                  placeholder='{ "result": true }'
                />
              </div>
              <div>
                <label
                  htmlFor="expected-output-hash"
                  className="form-label"
                  style={{
                    display: 'block',
                    marginBottom: '0.35rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Expected Output Hash
                </label>
                <input
                  id="expected-output-hash"
                  className="neo-input"
                  value={expectedOutputHash}
                  onChange={(event) => setExpectedOutputHash(event.target.value)}
                  placeholder="0x..."
                />
              </div>
              <div>
                <label
                  htmlFor="expected-attestation-hash"
                  className="form-label"
                  style={{
                    display: 'block',
                    marginBottom: '0.35rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Expected Attestation Hash
                </label>
                <input
                  id="expected-attestation-hash"
                  className="neo-input"
                  value={expectedAttestationHash}
                  onChange={(event) => setExpectedAttestationHash(event.target.value)}
                  placeholder="0x..."
                />
              </div>
              <div>
                <label
                  htmlFor="expected-compose-hash"
                  className="form-label"
                  style={{
                    display: 'block',
                    marginBottom: '0.35rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Expected Compose Hash
                </label>
                <input
                  id="expected-compose-hash"
                  className="neo-input"
                  value={expectedComposeHash}
                  onChange={(event) => setExpectedComposeHash(event.target.value)}
                  placeholder="0x..."
                />
              </div>
              <div>
                <label
                  htmlFor="expected-app-id"
                  className="form-label"
                  style={{
                    display: 'block',
                    marginBottom: '0.35rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Expected App ID
                </label>
                <input
                  id="expected-app-id"
                  className="neo-input"
                  value={expectedAppId}
                  onChange={(event) => setExpectedAppId(event.target.value)}
                  placeholder="morpheus-v1"
                />
              </div>
              <div>
                <label
                  htmlFor="expected-instance-id"
                  className="form-label"
                  style={{
                    display: 'block',
                    marginBottom: '0.35rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Expected Instance ID
                </label>
                <input
                  id="expected-instance-id"
                  className="neo-input"
                  value={expectedInstanceId}
                  onChange={(event) => setExpectedInstanceId(event.target.value)}
                  placeholder="instance-001"
                />
              </div>

              <button
                className="btn-ata"
                disabled={isVerifying}
                onClick={async () => {
                  setIsVerifying(true);
                  try {
                    let parsedAttestation: unknown;
                    let parsedPayload: unknown;
                    try {
                      parsedAttestation = JSON.parse(attestationJson);
                    } catch {
                      throw new Error('Invalid JSON in Attestation field — check syntax');
                    }
                    if (expectedPayloadJson.trim()) {
                      try {
                        parsedPayload = JSON.parse(expectedPayloadJson);
                      } catch {
                        throw new Error('Invalid JSON in Expected Payload field — check syntax');
                      }
                    }
                    const body = await runVerification({
                      attestation: parsedAttestation,
                      expectedPayload: parsedPayload,
                      expectedOutputHash,
                      expectedAttestationHash,
                      expectedComposeHash,
                      expectedAppId,
                      expectedInstanceId,
                    });
                    setResult(JSON.stringify(body, null, 2));
                  } catch (error) {
                    setResult(
                      JSON.stringify(
                        {
                          error: error instanceof Error ? error.message : String(error),
                        },
                        null,
                        2
                      )
                    );
                  } finally {
                    setIsVerifying(false);
                  }
                }}
              >
                {isVerifying ? 'Verifying...' : 'Run Verification'}
              </button>
            </div>
          </Card>
        </div>

        <Card className="oracle-tool-card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>Verification Result</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                Application-level checks for output_hash, attestation_hash, and report_data. Quote
                is checked for presence only — not validated against a Nitro/TDX root of trust.
              </p>
            </div>
            <CheckCircle2 size={20} color="var(--neo-green)" />
          </div>
          {result ? (
            <pre
              aria-live="polite"
              style={{
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-dim)',
                borderRadius: 'var(--ns-radius-sm)',
                padding: '1rem',
                fontSize: '0.8rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--neo-green)',
                overflow: 'auto',
                maxHeight: '400px',
                whiteSpace: 'pre-wrap',
              }}
            >
              {result}
            </pre>
          ) : (
            <div
              aria-live="polite"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                padding: '2rem 1.5rem',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-dim)',
                borderRadius: 'var(--ns-radius-sm)',
                color: 'var(--text-muted)',
              }}
            >
              <EmptyStateArt size={172} title="Awaiting verification input" />
              <p
                style={{
                  fontSize: '0.85rem',
                  marginTop: '0.75rem',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                Awaiting verification input...
              </p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export default function VerifierPage() {
  return (
    <Suspense
      fallback={
        <div className="container" style={{ padding: 'calc(72px + 2rem) 0' }}>
          <Skeleton height="200px" style={{ marginBottom: '1.5rem' }} />
          <div className="grid grid-2" style={{ gap: '1.5rem' }}>
            <Skeleton height="400px" />
            <Skeleton height="400px" />
          </div>
        </div>
      }
    >
      <VerifierPageClient />
    </Suspense>
  );
}
