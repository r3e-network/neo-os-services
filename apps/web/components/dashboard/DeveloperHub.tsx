'use client';

import { useState } from 'react';
import { Code2, Terminal, ChevronRight, Workflow, Fingerprint, Copy, Check } from 'lucide-react';
import {
  CONTRACT_EXAMPLE,
  AUTOMATION_PATTERNS,
  BUILTIN_FUNCTIONS,
  SECURITY_CONCEPTS,
} from '@/lib/docs-data';

export function DeveloperHub() {
  const [copied, setCopied] = useState<string | null>(null);
  const contractExample = CONTRACT_EXAMPLE;

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: '4rem' }}>
      {/* 1. Header & Architecture */}
      <section
        className="card-industrial"
        style={{
          padding: '3rem',
          textAlign: 'center',
          background:
            'radial-gradient(circle at center, rgba(139, 92, 246, 0.05) 0%, transparent 70%)',
        }}
      >
        <h2
          style={{
            fontSize: '2.5rem',
            fontWeight: 900,
            marginBottom: '1rem',
            letterSpacing: 0,
          }}
        >
          Protocol Reference
        </h2>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '1rem',
            maxWidth: '700px',
            margin: '0 auto 2rem',
          }}
        >
          Reference the current Morpheus stack, from sealed payload construction and callback
          routing to workflow orchestration and attestation review.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '2rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: 'var(--neo-green)',
              }}
            ></div>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
              TEE-PROVEN
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: 'var(--accent-purple)',
              }}
            ></div>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
              SEALED PAYLOADS
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: 'var(--accent-blue)',
              }}
            ></div>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
              ASYNC CALLBACKS
            </span>
          </div>
        </div>
      </section>

      {/* 2. Implementation & Code Examples */}
      <section className="stagger-1">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '2rem' }}>
          <Code2 className="text-neo" size={20} />
          <h3 style={{ fontSize: '1.25rem', fontWeight: 800 }}>Integration Examples</h3>
        </div>
        <div className="card-industrial" style={{ padding: '0', overflow: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              background: 'rgba(83, 58, 253, 0.045)',
              borderBottom: '1px solid var(--border-dim)',
              padding: '1rem 2rem',
            }}
          >
            <span
              style={{
                color: 'var(--text-primary)',
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
              }}
            >
              Neo N3 (C#)
            </span>
          </div>
          <div style={{ position: 'relative' }}>
            <pre
              className="code-editor"
              style={{
                borderRadius: 0,
                border: 'none',
                minHeight: '320px',
                fontSize: '0.85rem',
                background: 'transparent',
                boxShadow: 'none',
              }}
            >
              {contractExample}
            </pre>
            <button
              onClick={() => handleCopy(contractExample)}
              style={{
                position: 'absolute',
                top: '1.5rem',
                right: '1.5rem',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-highlight)',
                borderRadius: 'var(--ns-radius-xs)',
                padding: '8px',
                cursor: 'pointer',
              }}
            >
              {copied === contractExample ? (
                <Check size={14} className="text-neo" />
              ) : (
                <Copy size={14} className="text-muted" />
              )}
            </button>
          </div>
        </div>
      </section>

      {/* 3. API Dictionary */}
      <section className="stagger-2">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '2rem' }}>
          <Terminal className="text-accent-purple" size={20} />
          <h3 style={{ fontSize: '1.25rem', fontWeight: 800 }}>Enclave SDK (Javascript)</h3>
        </div>
        <div className="grid grid-2" style={{ gap: '1.5rem' }}>
          {BUILTIN_FUNCTIONS.map((fn) => (
            <div
              key={fn.name}
              className="card-industrial"
              style={{ padding: '1.75rem', borderLeft: '2px solid var(--accent-purple)' }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '1rem',
                  alignItems: 'center',
                }}
              >
                <code
                  style={{
                    color: 'var(--neo-green)',
                    fontWeight: 800,
                    fontSize: '0.95rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {fn.name}
                </code>
                <span
                  className="badge-outline"
                  style={{
                    color: 'var(--accent-purple)',
                    fontSize: '0.55rem',
                    borderColor: 'var(--accent-purple)',
                  }}
                >
                  {fn.category}
                </span>
              </div>
              <p
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                  marginBottom: '1.25rem',
                  lineHeight: 1.6,
                }}
              >
                {fn.desc}
              </p>
              <div
                style={{
                  background: 'var(--bg-panel)',
                  padding: '1rem',
                  borderRadius: 'var(--ns-radius-sm)',
                  border: '1px solid var(--border-dim)',
                }}
              >
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: 'var(--text-muted)',
                    marginBottom: '0.5rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  // Usage
                </div>
                <code
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-primary)',
                    wordBreak: 'break-all',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {fn.example}
                </code>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 4. Automation & Workflows */}
      <section className="stagger-3">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '2rem' }}>
          <Workflow className="text-neo" size={20} />
          <h3 style={{ fontSize: '1.25rem', fontWeight: 800 }}>Automation Blueprints</h3>
        </div>
        <div className="grid grid-2" style={{ gap: '2rem' }}>
          {AUTOMATION_PATTERNS.map((p) => (
            <div key={p.title} className="card-industrial" style={{ padding: '2rem' }}>
              <h4 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '1rem' }}>
                {p.title}
              </h4>
              <p
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                  marginBottom: '1.5rem',
                }}
              >
                {p.desc}
              </p>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                  marginBottom: '1.5rem',
                }}
              >
                {p.steps.map((step) => (
                  <div
                    key={step}
                    style={{
                      display: 'flex',
                      gap: '10px',
                      alignItems: 'center',
                      fontSize: '0.75rem',
                      color: 'var(--text-muted)',
                    }}
                  >
                    <ChevronRight size={12} className="text-neo" /> {step}
                  </div>
                ))}
              </div>

              <div
                style={{
                  background: 'var(--bg-panel)',
                  border: '1px solid var(--border-dim)',
                  borderRadius: 'var(--ns-radius-sm)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '0.75rem 1rem',
                    background: 'rgba(83, 58, 253, 0.045)',
                    fontSize: '0.65rem',
                    fontWeight: 800,
                    color: 'var(--text-secondary)',
                    borderBottom: '1px solid var(--border-dim)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  JSON CONFIG
                </div>
                <pre
                  style={{
                    padding: '1rem',
                    fontSize: '0.75rem',
                    color: 'var(--neo-green)',
                    opacity: 0.9,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {JSON.stringify(p.config, null, 2)}
                </pre>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 5. Security & Trust Model */}
      <section style={{ marginBottom: '4rem' }} className="stagger-4">
        <div
          className="card-industrial"
          style={{
            padding: '3rem',
            border: '1px solid rgba(239, 68, 68, 0.15)',
            background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.03), transparent)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '2rem' }}>
            <Fingerprint className="text-accent-purple" size={20} />
            <h3 style={{ fontSize: '1.25rem', fontWeight: 800 }}>Trust & Security Model</h3>
          </div>
          <div className="grid grid-3" style={{ gap: '2rem' }}>
            {SECURITY_CONCEPTS.map((c) => (
              <div key={c.title}>
                <h5
                  style={{
                    fontSize: '0.9rem',
                    fontWeight: 800,
                    marginBottom: '0.75rem',
                    color: 'var(--text-primary)',
                  }}
                >
                  {c.title}
                </h5>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  {c.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
