import { Check, CheckCircle, Shield } from 'lucide-react';
import Link from 'next/link';
import { networkRegistry } from '@/lib/networks';

export default function DocsVerifier() {
  const oracleAttestationExplorer =
    networkRegistry.mainnet.nitro?.oracle_attestation_explorer_url || '';
  const datafeedAttestationExplorer =
    networkRegistry.mainnet.nitro?.datafeed_attestation_explorer_url || '';

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <CheckCircle size={14} color="var(--neo-green)" />
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
          SECURITY SPEC
        </span>
      </div>
      <h1>Attestation & Security</h1>

      <p>
        Remote Attestation is the cornerstone of Morpheus's trust model. It lets external observers
        validate that the response metadata came from the expected Morpheus enclave deployment (AWS
        Nitro CVM) and that the quote is bound to the reported output hash and on-chain{' '}
        <code>attestation_hash</code>.
      </p>
      <div
        style={{
          margin: '1.5rem 0',
          padding: '1.25rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderLeft: '4px solid var(--accent-purple)',
          borderRadius: '0 var(--ns-radius-md) var(--ns-radius-md) 0',
        }}
      >
        <p
          style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}
        >
          <strong>Scope of trust:</strong> the built-in verifier confirms that the result is{' '}
          <em>enclave-key-signed</em> and that the hash binding + declared metadata are consistent,
          and that a quote and event log are <em>present</em>. It does <strong>not</strong> validate
          the Nitro/TDX quote against an AWS/Intel root of trust, so a passing result is{' '}
          <code>measurement_chain_verified: false</code>. Treat <code>full_attestation_ok</code> as
          presence-based, not a verified measurement chain.
        </p>
      </div>

      <h2>The Evidence Layer</h2>
      <p>
        Every task executed by a Morpheus worker can be bundled with an{' '}
        <strong>Attestation Quote</strong>. The verifier focuses on the application-level fields
        that are available in the live result envelope:
      </p>
      <ul style={{ listStyleType: 'none', paddingLeft: 0, margin: '2rem 0' }}>
        <li
          style={{
            marginBottom: '1.25rem',
            display: 'flex',
            gap: '0.75rem',
            padding: '1.25rem',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-dim)',
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <Check
            size={18}
            color="var(--neo-green)"
            strokeWidth={3}
            style={{ flexShrink: 0, marginTop: '0.15rem' }}
            aria-hidden="true"
          />
          <div>
            <strong
              style={{
                display: 'block',
                color: 'var(--text-primary)',
                marginBottom: '0.25rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              app_id / compose_hash
            </strong>
            <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Stable identifiers that let you confirm the response came from the expected Morpheus
              enclave deployment and compose bundle.
            </span>
          </div>
        </li>
        <li
          style={{
            marginBottom: '1.25rem',
            display: 'flex',
            gap: '0.75rem',
            padding: '1.25rem',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-dim)',
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <Check
            size={18}
            color="var(--neo-green)"
            strokeWidth={3}
            style={{ flexShrink: 0, marginTop: '0.15rem' }}
            aria-hidden="true"
          />
          <div>
            <strong
              style={{
                display: 'block',
                color: 'var(--text-primary)',
                marginBottom: '0.25rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              instance_id
            </strong>
            <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Identifies the concrete worker instance that produced the quote, useful for
              operational forensics and replay analysis.
            </span>
          </div>
        </li>
        <li
          style={{
            display: 'flex',
            gap: '0.75rem',
            padding: '1.25rem',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-dim)',
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <Check
            size={18}
            color="var(--neo-green)"
            strokeWidth={3}
            style={{ flexShrink: 0, marginTop: '0.15rem' }}
            aria-hidden="true"
          />
          <div>
            <strong
              style={{
                display: 'block',
                color: 'var(--text-primary)',
                marginBottom: '0.25rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              attestation_hash / report_data
            </strong>
            <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Morpheus currently sets <code>attestation_hash == output_hash</code>. The verifier
              compares the first 32 bytes of TDX <code>report_data</code> against that hash.
            </span>
          </div>
        </li>
      </ul>

      <h2>Off-Chain Verification Flow</h2>
      <p>
        While on-chain contracts verify the worker signature, high-security applications should also
        perform off-chain verification:
      </p>
      <ol>
        <li>
          Fetch the callback envelope or worker response, then read <code>output_hash</code>,{' '}
          <code>attestation_hash</code>, and <code>tee_attestation.report_data</code>.
        </li>
        <li>
          Verify that <code>attestation_hash == output_hash</code>.
        </li>
        <li>
          Verify that the first 32 bytes of <code>report_data</code> match that same hash.
        </li>
        <li>
          Check <code>app_id</code> and <code>compose_hash</code> against the published Morpheus
          deployment metadata.
        </li>
        <li>
          The built-in verifier stops here: it confirms the enclave-key signature and hash binding
          and that a quote is present, but it does not check the Nitro/TDX quote against a hardware
          root of trust. For full measurement-chain validation, perform an additional
          platform-specific verification pass (AWS Nitro / Intel TDX) outside the built-in web
          verifier.
        </li>
      </ol>

      <h2>Published CVM Explorers</h2>
      <p>
        Morpheus now runs with role-specialized enclaves (Nitro CVMs). The Oracle request/response
        runtime and the DataFeed runtime have separate published explorer pages, and those pages are
        the canonical public attestation anchors for both mainnet and testnet traffic.
      </p>
      <ul>
        <li>
          Oracle request CVM: <code>ddff154546fe22d15b65667156dd4b7c611e6093</code>{' '}
          {oracleAttestationExplorer ? (
            <a href={oracleAttestationExplorer} target="_blank" rel="noreferrer">
              {oracleAttestationExplorer}
            </a>
          ) : null}
        </li>
        <li>
          DataFeed CVM: <code>ac5b6886a2832df36e479294206611652400178f</code>{' '}
          {datafeedAttestationExplorer ? (
            <a href={datafeedAttestationExplorer} target="_blank" rel="noreferrer">
              {datafeedAttestationExplorer}
            </a>
          ) : null}
        </li>
      </ul>

      <div
        style={{
          margin: '2.5rem 0',
          padding: '1.5rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-md)',
        }}
      >
        <div
          style={{
            fontSize: '0.7rem',
            color: 'var(--text-muted)',
            fontWeight: 800,
            marginBottom: '1rem',
            fontFamily: 'var(--font-mono)',
          }}
        >
          VERIFIER TOOL
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Morpheus provides a built-in <strong>Attestation Verifier</strong> in the Explorer. You
          can paste any worker response to validate its hardware proof instantly.
        </p>
        <Link
          href="/verifier"
          className="btn btn-secondary btn-sm"
          style={{ textDecoration: 'none' }}
        >
          OPEN VERIFIER
        </Link>
      </div>

      <h2>Trust Boundaries</h2>
      <p>
        By combining hardware isolation with cryptographic proof, Morpheus shifts the security
        boundary from <strong>"Trust the Operator"</strong> to <strong>"Trust the Code"</strong>.
      </p>

      <div
        style={{
          marginTop: '4rem',
          padding: '2.5rem',
          background: 'var(--bg-panel)',
          borderTop: '1px solid var(--border-dim)',
          borderRight: '1px solid var(--border-dim)',
          borderBottom: '1px solid var(--border-dim)',
          borderLeft: '4px solid var(--neo-green)',
          borderRadius: '0 4px 4px 0',
        }}
      >
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
          <Shield size={20} color="var(--neo-green)" />
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
            Auditability
          </h4>
        </div>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-secondary)',
            marginBottom: 0,
            lineHeight: 1.6,
          }}
        >
          The entire Morpheus worker runtime is open-source. Security auditors can independently
          verify the code paths that produce the reported output hash, transport encryption
          metadata, and callback envelope format.
        </p>
      </div>
    </div>
  );
}
