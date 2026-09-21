import { HelpCircle, AlertCircle } from 'lucide-react';

export default function DocsFAQ() {
  const faqs = [
    {
      q: 'What is the request fee for the Privacy Oracle?',
      a: "The current fee is 0.01 GAS (or equivalent) per request. This covers the TEE computation time and the relayer's transaction costs for the on-chain callback.",
    },
    {
      q: 'Which networks are currently supported?',
      a: 'Neo N3 mainnet is the live production environment, and Neo N3 testnet is tracked separately with its own CVM, contract registry, and generated env files. Public support is currently Neo N3 only.',
    },
    {
      q: 'Do I need to run my own relayer?',
      a: 'Not to get started, but you should understand what you are depending on. One operator runs the relayer today — it is a single node, not a pool — so availability and censorship-resistance depend on that operator. Running your own relayer instance is how you remove that dependency; there is no second party to route around otherwise.',
    },
    {
      q: 'Is the TEE code open source?',
      a: 'Yes. The worker, relayer, contracts, and frontend are open source. The public verifier checks the AWS Nitro measurement chain (pinned root certificate, committed PCR0/1/2) and that the attestation document is bound to the result you are verifying.',
    },
    {
      q: 'What does the TEE not protect against?',
      a: 'The workflow logic and the enclave binary are public by design; inputs and outputs at the enclave boundary are observable; side channels and speculative execution can leak; the host sees egress destination metadata even though payloads are end-to-end TLS; and a single operator can censor or halt requests. See Attestation & Security for the full list.',
    },
  ];

  const errors = [
    {
      code: '0x01',
      name: 'INVALID_SIGNATURE',
      desc: 'The callback signature does not match the configured Oracle Verifier Key. Ensure your contract is pointing to the correct Morpheus registry.',
    },
    {
      code: '0x02',
      name: 'INSUFFICIENT_FEE',
      desc: 'The request fee was not prepaid correctly. On Neo N3, deposit or sponsor 0.01 GAS fee credit first.',
    },
    {
      code: '0x03',
      name: 'TEE_TIMEOUT',
      desc: 'The request exceeded the configured execution timeout. The system should still finalize the request with a failure callback instead of dropping it.',
    },
  ];

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <HelpCircle size={14} color="var(--neo-green)" />
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
          SUPPORT
        </span>
      </div>
      <h1>FAQ & Troubleshooting</h1>

      <p
        className="lead"
        style={{ fontSize: '1.15rem', color: 'var(--text-primary)', marginBottom: '3rem' }}
      >
        Common questions about integration, security, and network operations.
      </p>

      <h2>Frequently Asked Questions</h2>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginBottom: '4rem' }}
      >
        {faqs.map((faq, i) => (
          <div
            key={i}
            style={{
              padding: '1.5rem',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              borderRadius: 'var(--ns-radius-md)',
              borderLeft: '3px solid var(--neo-green)',
            }}
          >
            <h3
              style={{
                fontSize: '1rem',
                marginTop: 0,
                color: 'var(--text-primary)',
                marginBottom: '0.75rem',
                fontWeight: 800,
              }}
            >
              Q: {faq.q}
            </h3>
            <p
              style={{
                fontSize: '0.95rem',
                color: 'var(--text-secondary)',
                marginBottom: 0,
                lineHeight: 1.6,
              }}
            >
              {faq.a}
            </p>
          </div>
        ))}
      </div>

      <h2>Error Codes</h2>
      <p>
        If your callback receives a failure status, refer to the table below to diagnose the issue.
      </p>

      <div
        style={{
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-sm)',
          overflow: 'hidden',
          margin: '2rem 0',
          background: 'var(--bg-panel)',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.85rem',
            textAlign: 'left',
          }}
        >
          <thead>
            <tr
              style={{
                background: 'rgba(83, 58, 253, 0.045)',
                borderBottom: '1px solid var(--border-dim)',
              }}
            >
              <th style={{ padding: '1rem 1.5rem', color: 'var(--text-primary)', fontWeight: 800 }}>
                CODE
              </th>
              <th style={{ padding: '1rem 1.5rem', color: 'var(--text-primary)', fontWeight: 800 }}>
                NAME
              </th>
              <th style={{ padding: '1rem 1.5rem', color: 'var(--text-primary)', fontWeight: 800 }}>
                DESCRIPTION
              </th>
            </tr>
          </thead>
          <tbody>
            {errors.map((err, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                <td
                  style={{
                    padding: '1.25rem 1.5rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--neo-green)',
                  }}
                >
                  {err.code}
                </td>
                <td style={{ padding: '1.25rem 1.5rem', fontWeight: 800, color: 'var(--error)' }}>
                  {err.name}
                </td>
                <td
                  style={{
                    padding: '1.25rem 1.5rem',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.6,
                  }}
                >
                  {err.desc}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        style={{
          marginTop: '4rem',
          padding: '2rem',
          background: 'var(--bg-panel)',
          borderTop: '1px solid var(--border-dim)',
          borderRight: '1px solid var(--border-dim)',
          borderBottom: '1px solid var(--border-dim)',
          borderLeft: '4px solid var(--accent-blue)',
          borderRadius: '0 4px 4px 0',
        }}
      >
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
          <AlertCircle size={20} color="var(--accent-blue)" />
          <h4
            style={{
              fontSize: '1rem',
              fontWeight: 800,
              margin: 0,
              color: 'var(--text-primary)',
              textTransform: 'uppercase',
              letterSpacing: 0,
            }}
          >
            Still having issues?
          </h4>
        </div>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-secondary)',
            marginBottom: '1.5rem',
            lineHeight: 1.6,
          }}
        >
          If you encounter an error not listed here, please provide your <code>requestId</code> and{' '}
          <code>transactionHash</code> to our support team.
        </p>
        <a
          href="https://github.com/r3e-network/neo-os-services/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-secondary btn-sm"
          style={{
            fontWeight: 800,
            letterSpacing: 0,
            border: '1px solid var(--border-dim)',
            textDecoration: 'none',
          }}
        >
          OPEN ISSUE
        </a>
      </div>
    </div>
  );
}
