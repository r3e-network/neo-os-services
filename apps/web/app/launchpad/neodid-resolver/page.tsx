'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ExternalLink, Fingerprint, Search } from 'lucide-react';
import { CodeBlock } from '@/components/ui/CodeBlock';
import {
  DEFAULT_NEODID_AA_DID,
  DEFAULT_NEODID_SERVICE_DID,
  DEFAULT_NEODID_VAULT_DID,
} from '@/lib/neodid-did-common';

async function requestDidJson(did: string, format: 'resolution' | 'document') {
  const response = await fetch(
    `/api/neodid/resolve?did=${encodeURIComponent(did)}${format === 'document' ? '&format=document' : ''}`,
    {
      cache: 'no-store',
    }
  );
  const text = await response.text();
  try {
    return {
      ok: response.ok,
      status: response.status,
      body: JSON.parse(text),
    };
  } catch {
    return {
      ok: response.ok,
      status: response.status,
      body: { raw: text },
    };
  }
}

function ResolverClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialDid = searchParams.get('did') || DEFAULT_NEODID_SERVICE_DID;
  const initialFormat = searchParams.get('format') === 'document' ? 'document' : 'resolution';

  const [did, setDid] = useState(initialDid);
  const [format, setFormat] = useState<'resolution' | 'document'>(initialFormat);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const examples = useMemo(
    () =>
      [
        { label: 'Service DID', value: DEFAULT_NEODID_SERVICE_DID },
        { label: 'Vault DID', value: DEFAULT_NEODID_VAULT_DID },
        { label: 'AA DID', value: DEFAULT_NEODID_AA_DID },
      ].filter((item) => item.value),
    []
  );

  const resolveDid = useCallback(
    async (nextDid: string, nextFormat: 'resolution' | 'document', updateUrl = true) => {
      const trimmed = nextDid.trim();
      if (!trimmed) {
        setError('DID is required');
        setResult(null);
        return;
      }

      if (updateUrl) {
        const query = new URLSearchParams({ did: trimmed });
        if (nextFormat === 'document') query.set('format', 'document');
        router.replace(`/launchpad/neodid-resolver?${query.toString()}`);
      }

      setLoading(true);
      setError('');
      try {
        const response = await requestDidJson(trimmed, nextFormat);
        setResult(response.body);
        if (!response.ok) {
          const message =
            typeof response.body?.didResolutionMetadata === 'object' &&
            response.body?.didResolutionMetadata &&
            'message' in response.body.didResolutionMetadata
              ? String(
                  (response.body.didResolutionMetadata as Record<string, unknown>).message || ''
                )
              : `Resolver returned ${response.status}`;
          setError(message);
        }
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [router]
  );

  useEffect(() => {
    void resolveDid(initialDid, initialFormat, false);
  }, [initialDid, initialFormat, resolveDid]);

  return (
    <div className="min-h-screen flex flex-col">
      <main className="container" style={{ flex: 1, padding: 'calc(72px + 2rem) 0 4rem' }}>
        <div className="fade-in">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
            <Fingerprint size={14} color="var(--neo-green)" />
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
              W3C DID RESOLUTION
            </span>
          </div>
          <h1 style={{ fontSize: 'clamp(2.3rem, 5vw, 3.1rem)', marginBottom: '1rem' }}>
            NeoDID Resolver
          </h1>
          <p
            className="lead"
            style={{
              maxWidth: '860px',
              lineHeight: 1.7,
              color: 'var(--text-secondary)',
              marginBottom: '2rem',
            }}
          >
            Resolve the public W3C DID document for the Morpheus NeoDID service, a vault subject
            namespace, or an AA recovery namespace. The resolver intentionally exposes service
            metadata and verifier material only. Provider UIDs, master nullifiers, encrypted params,
            and action tickets remain private.
          </p>

          <div className="card-industrial" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'grid', gap: '1rem' }}>
              <div>
                <div
                  style={{
                    fontSize: '0.72rem',
                    marginBottom: '0.5rem',
                    color: 'var(--text-muted)',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: 0,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  DID
                </div>
                <input
                  value={did}
                  onChange={(event) => setDid(event.target.value)}
                  placeholder="did:morpheus:neo_n3:service:neodid"
                  style={{
                    width: '100%',
                    background: 'rgba(83, 58, 253, 0.06)',
                    border: '1px solid var(--border-dim)',
                    color: 'var(--text-primary)',
                    padding: '0.9rem 1rem',
                    borderRadius: 'var(--ns-radius-md)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.85rem',
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                <button
                  className={`btn ${format === 'resolution' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setFormat('resolution')}
                >
                  Resolution Object
                </button>
                <button
                  className={`btn ${format === 'document' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setFormat('document')}
                >
                  DID Document
                </button>
                <button className="btn btn-secondary" onClick={() => void resolveDid(did, format)}>
                  <Search size={16} /> {loading ? 'Resolving...' : 'Resolve'}
                </button>
                <a
                  href={`/api/neodid/resolve?did=${encodeURIComponent(did)}${format === 'document' ? '&format=document' : ''}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary"
                  style={{ textDecoration: 'none' }}
                >
                  Raw API <ExternalLink size={16} />
                </a>
              </div>
            </div>
          </div>

          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.75rem' }}
          >
            {examples.map((example) => (
              <button
                key={example.value}
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setDid(example.value);
                  void resolveDid(example.value, format);
                }}
              >
                {example.label}
              </button>
            ))}
          </div>

          {error ? (
            <div
              className="card-industrial"
              style={{
                padding: '1rem 1.25rem',
                borderLeft: '4px solid #ff7b72',
                marginBottom: '1.5rem',
              }}
            >
              <strong style={{ color: 'var(--text-primary)' }}>Resolver status:</strong>{' '}
              <span style={{ color: 'var(--text-secondary)' }}>{error}</span>
            </div>
          ) : null}

          {result ? (
            <CodeBlock
              language="json"
              title={
                format === 'document'
                  ? 'application/did+ld+json'
                  : 'application/ld+json;profile="https://w3id.org/did-resolution"'
              }
              code={JSON.stringify(result, null, 2)}
            />
          ) : null}

          <div className="grid grid-2" style={{ gap: '1.25rem', marginTop: '2rem' }}>
            <Link
              href="/docs/neodid"
              className="card-industrial"
              style={{ padding: '1.5rem', textDecoration: 'none' }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                  NeoDID Docs
                </span>
                <ExternalLink size={18} color="var(--neo-green)" />
              </div>
              <p style={{ color: 'var(--text-secondary)', marginTop: '0.85rem', marginBottom: 0 }}>
                Read the bind, action-ticket, recovery-ticket, Web3Auth, and DID method model in one
                place.
              </p>
            </Link>
            <Link
              href="/docs/r/NEODID_DID_METHOD"
              className="card-industrial"
              style={{ padding: '1.5rem', textDecoration: 'none' }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                  DID Method Spec
                </span>
                <ExternalLink size={18} color="var(--neo-green)" />
              </div>
              <p style={{ color: 'var(--text-secondary)', marginTop: '0.85rem', marginBottom: 0 }}>
                Open the formal method syntax, privacy guarantees, subject types, and API examples.
              </p>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function NeoDidResolverPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-main" />}>
      <ResolverClient />
    </Suspense>
  );
}
