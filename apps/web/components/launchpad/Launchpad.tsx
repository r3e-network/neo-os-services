'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Cpu,
  Fingerprint,
  Lock,
  Shield,
  Sparkles,
} from 'lucide-react';
import { NETWORKS } from '@/lib/onchain-data';
import { NeoMascot } from '@/components/illustrations';

type LaunchpadProps = {
  embedded?: boolean;
};

const journeys = [
  {
    id: 'oracle',
    title: 'Privacy Oracle',
    icon: Shield,
    summary:
      'Use the shared kernel fetch module to pull outside data, optionally hide secrets, optionally run a reduction, then read the system inbox or an optional callback adapter.',
    requestType: 'privacy_oracle / oracle',
    steps: [
      {
        title: 'Choose a starter',
        desc: 'Start from a ready payload or scenario.',
        href: '/docs/templates',
        label: 'Starter Templates',
      },
      {
        title: 'Build and encrypt',
        desc: 'Use Starter Studio or Workbench > Oracle Requests to seal sensitive fields locally.',
        href: '/docs/studio',
        label: 'Starter Studio',
      },
      {
        title: 'Submit on-chain',
        desc: `Call the shared kernel at ${NETWORKS.neo_n3.oracle}; legacy callback-method flows still work, but the system inbox is canonical.`,
        href: '/explorer',
        label: 'Open Workbench',
      },
      {
        title: 'Read callback',
        desc: `Read the kernel-managed result path first, or use the optional universal adapter ${NETWORKS.neo_n3.exampleConsumer || NETWORKS.neo_n3.callbackConsumer} during migration/testing.`,
        href: '/docs/quickstart',
        label: 'Quickstart',
      },
      {
        title: 'Verify result',
        desc: 'Check output_hash, attestation_hash, and report_data binding.',
        href: '/verifier',
        label: 'Open Verifier',
      },
    ],
  },
  {
    id: 'compute',
    title: 'Privacy Compute',
    icon: Cpu,
    summary:
      'Run built-in compute or custom JS/WASM inside the enclave through the shared kernel, then read the system inbox or an optional callback adapter.',
    requestType: 'compute',
    steps: [
      {
        title: 'Pick a built-in or script',
        desc: 'Use built-in helpers first unless you truly need custom logic.',
        href: '/docs/use-cases',
        label: 'Use Cases',
      },
      {
        title: 'Generate package',
        desc: 'Use Starter Studio or Workbench > Private Compute to generate a compute payload.',
        href: '/docs/studio',
        label: 'Starter Studio',
      },
      {
        title: 'Submit on-chain',
        desc: `Call ${NETWORKS.neo_n3.oracle} with the shared compute module path; legacy requestType = compute remains available for compatibility.`,
        href: '/explorer',
        label: 'Open Workbench',
      },
      {
        title: 'Read callback',
        desc: 'Read the kernel inbox or, if you configured one, getCallback(requestId) from your optional adapter after fulfillment.',
        href: '/docs/quickstart',
        label: 'Quickstart',
      },
      {
        title: 'Verify result',
        desc: 'Verify the callback envelope and attestation metadata in the verifier.',
        href: '/verifier',
        label: 'Open Verifier',
      },
    ],
  },
  {
    id: 'zero_code',
    title: `Zero-Code ${NETWORKS.neo_n3.environmentLabel} Test`,
    icon: Lock,
    summary:
      'Use the optional universal callback adapter to test the system without deploying your own contract-specific bridge first.',
    requestType: 'privacy_oracle / compute',
    steps: [
      {
        title: 'Pick a canned flow',
        desc: 'Use public quote, private API, boolean check, privacy.mask, or encrypted modexp.',
        href: '/docs/studio',
        label: 'Starter Studio',
      },
      {
        title: 'Use the universal consumer',
        desc: `Use optional adapter hash = ${NETWORKS.neo_n3.exampleConsumer || NETWORKS.neo_n3.callbackConsumer} and callback method = onOracleResult only if you want external callback storage instead of the canonical kernel inbox.`,
        href: '/docs/templates',
        label: 'Templates',
      },
      {
        title: 'Pre-fund fee credit',
        desc: 'On Neo N3, pre-fund 0.01 GAS Oracle credit before sending the request.',
        href: '/docs/quickstart',
        label: 'Quickstart',
      },
      {
        title: 'Submit request',
        desc: 'Use the generated NeoLine or JSON-RPC invoke parameters directly.',
        href: '/explorer',
        label: 'Open Workbench',
      },
      {
        title: 'Read and verify',
        desc: 'Read the kernel result path or call getCallback(requestId) on the optional adapter, then paste the result into the verifier.',
        href: '/verifier',
        label: 'Open Verifier',
      },
    ],
  },
  {
    id: 'verify',
    title: 'Verify A Result',
    icon: CheckCircle2,
    summary:
      'Validate the callback or worker output and make sure the enclave proof is bound correctly.',
    requestType: 'verification',
    steps: [
      {
        title: 'Collect the envelope',
        desc: 'Get the callback result bytes or the worker response JSON.',
        href: '/docs/quickstart',
        label: 'Quickstart',
      },
      {
        title: 'Open verifier',
        desc: 'Paste the callback envelope or raw tee_attestation JSON.',
        href: '/verifier',
        label: 'Open Verifier',
      },
      {
        title: 'Compare hashes',
        desc: 'Check output_hash, attestation_hash, and report_data prefix.',
        href: '/docs/verifier',
        label: 'Attestation Spec',
      },
      {
        title: 'Confirm deployment',
        desc: 'Match the app_id / compose_hash with published production metadata.',
        href: '/docs/networks',
        label: 'Networks',
      },
      {
        title: 'Store the result',
        desc: 'Persist the requestId, tx hash, and verified result inside your own application workflow and operational logs.',
        href: '/docs/api-reference',
        label: 'API Reference',
      },
    ],
  },
  {
    id: 'neodid',
    title: 'NeoDID',
    icon: Fingerprint,
    summary:
      'Bind Web2 or exchange identities, resolve a W3C DID document, issue unlinkable action tickets, and mint AA recovery tickets through the same shared kernel pipeline.',
    requestType: 'neodid_bind / neodid_action_ticket / neodid_recovery_ticket',
    steps: [
      {
        title: 'Read the model',
        desc: 'Understand master nullifiers, action nullifiers, the W3C DID method, and the independent NeoDID registry contract.',
        href: '/docs/neodid',
        label: 'NeoDID Docs',
      },
      {
        title: 'Inspect the DID',
        desc: 'Resolve the public DID document for the NeoDID service, a vault namespace, or an AA recovery namespace.',
        href: '/launchpad/neodid-resolver',
        label: 'Open Resolver',
      },
      {
        title: 'Choose the flow',
        desc: 'Pick binding, action ticket, or AA social recovery ticket based on your application.',
        href: '/docs/use-cases',
        label: 'Use Cases',
      },
      {
        title: 'Login and fetch JWT',
        desc: 'Open the live Web3Auth studio, sign in, fetch a real id_token, and optionally seal it locally before submission.',
        href: '/launchpad/neodid-live',
        label: 'Web3Auth Live',
      },
      {
        title: 'Submit on-chain',
        desc: 'Submit neodid_bind, neodid_action_ticket, or neodid_recovery_ticket through the shared kernel; legacy MorpheusOracle.request remains a compatibility path.',
        href: '/docs/neodid',
        label: 'Oracle Flow',
      },
      {
        title: 'Register or consume',
        desc: 'Store the binding in NeoDIDRegistry, consume an action ticket in a DApp, or consume a recovery ticket in an AA recovery verifier.',
        href: '/docs/r/AA_SOCIAL_RECOVERY',
        label: 'AA Recovery Spec',
      },
    ],
  },
];

export function Launchpad({ embedded = false }: LaunchpadProps) {
  const [journeyId, setJourneyId] = useState(journeys[0].id);
  const journey = useMemo(
    () => journeys.find((item) => item.id === journeyId) || journeys[0],
    [journeyId]
  );
  const JourneyIcon = journey.icon;

  return (
    <div className={embedded ? 'fade-up' : 'fade-in'}>
      {!embedded && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1.5rem',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}
            >
              <Boxes size={14} color="var(--neo-green)" />
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
                UNIFIED LAUNCHPAD
              </span>
            </div>
            <h1>Launchpad</h1>
          </div>
          <NeoMascot variant="brand" size={108} />
        </div>
      )}

      <p
        className="lead"
        style={{
          fontSize: '1.1rem',
          color: 'var(--text-primary)',
          marginBottom: '2.5rem',
          lineHeight: 1.6,
        }}
      >
        One entrance for the full user journey. Pick the thing you want to do, then follow the exact
        next step without deciding whether to start in Oracle, Compute, Templates, Studio,
        Quickstart, or Verifier first.
      </p>

      <div className="card-industrial" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem' }}>
          <Sparkles size={18} color="var(--neo-green)" />
          <h3
            style={{
              margin: 0,
              fontSize: '0.95rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Choose Your Goal
          </h3>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
          {journeys.map((item) => {
            const Icon = item.icon;
            const active = item.id === journeyId;
            return (
              <button
                key={item.id}
                className="btn-secondary"
                aria-pressed={active}
                style={{
                  border: '1px solid',
                  borderColor: active ? 'var(--neo-green)' : 'var(--border-dim)',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: active ? 'var(--neo-green-dim)' : 'transparent',
                }}
                onClick={() => setJourneyId(item.id)}
              >
                <Icon size={14} /> {item.title}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card-industrial" style={{ padding: '1.75rem', marginBottom: '2rem' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '0.85rem' }}
        >
          <JourneyIcon size={20} color="var(--neo-green)" />
          <h2
            style={{
              margin: 0,
              border: 'none',
              padding: 0,
              fontSize: '1.25rem',
              textTransform: 'none',
            }}
          >
            {journey.title}
          </h2>
        </div>
        <p style={{ marginTop: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          {journey.summary}
        </p>
        <div
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Primary request type: {journey.requestType}
        </div>
      </div>

      <div style={{ display: 'grid', gap: '1rem' }}>
        {journey.steps.map((step, index) => (
          <div
            key={step.title}
            className="card-industrial"
            style={{
              padding: '1.5rem',
              display: 'grid',
              gridTemplateColumns: '80px 1fr auto',
              gap: '1rem',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                fontSize: '1.1rem',
                fontWeight: 900,
                color: 'var(--neo-green)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {String(index + 1).padStart(2, '0')}
            </div>
            <div>
              <div
                style={{
                  fontSize: '1rem',
                  fontWeight: 800,
                  color: 'var(--text-primary)',
                  marginBottom: '0.35rem',
                }}
              >
                {step.title}
              </div>
              <div style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>{step.desc}</div>
            </div>
            <Link
              href={step.href}
              className="btn btn-secondary btn-sm"
              style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}
            >
              {step.label} <ArrowRight size={14} />
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
