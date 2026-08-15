import Link from 'next/link';
import {
  ArrowRight,
  Shield,
  Cpu,
  Zap,
  Terminal,
  ClipboardList,
  Activity,
  Fingerprint,
  CheckCircle,
  Database,
} from 'lucide-react';

const architectureCards = [
  {
    icon: Zap,
    title: 'On-Chain Interface',
    desc: 'Neo N3 contracts own request submission, callback routing, and on-chain verification boundaries.',
  },
  {
    icon: Terminal,
    title: 'Serverless Control Plane',
    desc: 'Cloudflare Workers, Queues, and Workflows own ingress, validation, orchestration, and recovery.',
  },
  {
    icon: Database,
    title: 'Durable State',
    desc: 'Supabase stores requests, relayer jobs, control-plane jobs, automation state, feed snapshots, and logs.',
  },
  {
    icon: Shield,
    title: 'Confidential Execution',
    desc: 'Role-split Oracle and DataFeed CVMs execute private workloads and publish attested results.',
  },
];

const nextStepCards = [
  {
    href: '/docs/quickstart',
    title: 'Quickstart',
    description: 'Integrate the Neo N3 request/callback path and seal payloads locally.',
    icon: ArrowRight,
  },
  {
    href: '/docs/architecture',
    title: 'Architecture',
    description: 'Review the current four-layer production design and runtime split.',
    icon: ArrowRight,
  },
  {
    href: '/docs/r/DEPLOYMENT',
    title: 'Deployment',
    description: 'Use the canonical Cloudflare + Vercel + Supabase + dual-CVM rollout model.',
    icon: ClipboardList,
  },
  {
    href: '/docs/networks',
    title: 'Networks',
    description: 'Inspect the canonical contracts, domains, CVM ids, and attestation explorers.',
    icon: ClipboardList,
  },
  {
    href: '/docs/r/OPERATIONS',
    title: 'Operations',
    description: 'Understand priority isolation, recovery, backlog handling, and observability.',
    icon: Activity,
  },
  {
    href: '/docs/r/VALIDATION',
    title: 'Validation',
    description: 'Run the canonical test, smoke, signer, and end-to-end verification sequence.',
    icon: CheckCircle,
  },
  {
    href: '/docs/feed-status',
    title: 'Feed Status',
    description:
      'Compare configured feed pairs, live quotes, on-chain values, and deprecated keys.',
    icon: Activity,
  },
  {
    href: '/docs/neodid',
    title: 'NeoDID',
    description: 'Review the confidential NeoDID bind and ticket flows plus DID resolver surface.',
    icon: Fingerprint,
  },
];

export default function DocsIntroduction() {
  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1.5rem' }}>
        <div className="status-dot"></div>
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 800,
            color: 'var(--neo-green)',
            letterSpacing: 0,
            fontFamily: 'var(--font-mono)',
          }}
        >
          DOCUMENTATION
        </span>
      </div>

      <h1>NeoOS Services Documentation</h1>

      <p
        className="lead"
        style={{ fontSize: '1.25rem', color: 'var(--text-primary)', marginBottom: '2.5rem' }}
      >
        NeoOS Services is a Neo N3 confidential oracle stack with serverless ingress, durable
        orchestration, isolated datafeeds, and role-split confidential execution.
      </p>

      <div className="grid grid-2" style={{ gap: '1.5rem', marginBottom: '4rem' }}>
        <div className="card-industrial" style={{ padding: '1.5rem' }}>
          <Shield size={20} color="var(--neo-green)" style={{ marginBottom: '1rem' }} />
          <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Confidentiality</h3>
          <p style={{ fontSize: '0.85rem', marginBottom: 0 }}>
            Sensitive payloads are sealed before submission and only unsealed inside the Oracle CVM.
          </p>
        </div>
        <div className="card-industrial" style={{ padding: '1.5rem' }}>
          <Cpu size={20} color="var(--accent-blue)" style={{ marginBottom: '1rem' }} />
          <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Separation Of Concerns</h3>
          <p style={{ fontSize: '0.85rem', marginBottom: 0 }}>
            Scheduling and recovery stay outside the TEE; confidential execution stays inside it.
          </p>
        </div>
      </div>

      <h2>Why This Design</h2>
      <p>
        Morpheus is built so the TEE does only the work that truly requires confidentiality.
        Authentication, request validation, backpressure, retry, recovery, and status inspection are
        all handled outside the confidential runtime.
      </p>

      <blockquote
        style={{
          borderLeft: '3px solid var(--neo-green)',
          background: 'rgba(22, 199, 132, 0.06)',
          padding: '1.5rem',
          margin: '2rem 0',
          borderRadius: '0 var(--ns-radius-sm) var(--ns-radius-sm) 0',
        }}
      >
        <strong>Current production rule:</strong> Oracle request/response work runs on the Oracle
        CVM, feed publication runs on the dedicated DataFeed CVM, and Cloudflare Workflows own the
        callback and automation orchestration lanes.
      </blockquote>

      <h2>Core Architecture</h2>
      <p>The current production design is a four-layer stack.</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', margin: '2.5rem 0' }}>
        {architectureCards.map((item, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: '1.5rem',
              padding: '1.5rem',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <div
              style={{
                background: 'var(--neo-green-dim)',
                padding: '12px',
                borderRadius: 'var(--ns-radius-md)',
                height: 'fit-content',
                border: '1px solid rgba(22, 199, 132, 0.18)',
              }}
            >
              <item.icon size={20} color="var(--neo-green)" />
            </div>
            <div>
              <h4
                style={{
                  fontSize: '0.95rem',
                  fontWeight: 800,
                  marginBottom: '0.4rem',
                  color: 'var(--text-primary)',
                  letterSpacing: 0,
                  textTransform: 'uppercase',
                }}
              >
                {item.title}
              </h4>
              <p
                style={{
                  fontSize: '0.9rem',
                  color: 'var(--text-secondary)',
                  marginBottom: 0,
                  lineHeight: 1.6,
                }}
              >
                {item.desc}
              </p>
            </div>
          </div>
        ))}
      </div>

      <h2>Next Steps</h2>
      <div className="grid grid-2" style={{ gap: '1.5rem' }}>
        {nextStepCards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.href}
              href={card.href}
              className="card-industrial"
              style={{ padding: '2rem', textDecoration: 'none', transition: 'border-color 0.2s' }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                  {card.title.toUpperCase()}
                </span>
                <Icon size={18} color="var(--neo-green)" />
              </div>
              <p
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                  marginTop: '1rem',
                  marginBottom: 0,
                }}
              >
                {card.description}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
