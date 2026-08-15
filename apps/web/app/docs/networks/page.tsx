'use client';

import { Globe, Copy, Check, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import { networkRegistry, getSelectedNetworkKey } from '@/lib/networks';

function normalizeValue(value: string | undefined | null, fallback: string) {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

export default function DocsNetworks() {
  const [copied, setCopied] = useState<string | null>(null);
  const selectedKey = getSelectedNetworkKey();

  const rows = useMemo(() => {
    const mainnet = networkRegistry.mainnet;
    const testnet = networkRegistry.testnet;
    return [
      {
        label: 'Oracle Runtime URL',
        mainnet: normalizeValue(mainnet.nitro?.public_api_url, 'unassigned'),
        testnet: normalizeValue(testnet.nitro?.public_api_url, 'unassigned'),
      },
      {
        label: 'Edge Runtime URL',
        mainnet: normalizeValue(mainnet.nitro?.edge_public_url, 'unassigned'),
        testnet: normalizeValue(testnet.nitro?.edge_public_url, 'unassigned'),
      },
      {
        label: 'Control Plane URL',
        mainnet: normalizeValue(mainnet.nitro?.control_plane_url, 'unassigned'),
        testnet: normalizeValue(testnet.nitro?.control_plane_url, 'unassigned'),
      },
      {
        label: 'Oracle CVM ID',
        mainnet: normalizeValue(mainnet.nitro?.cvm_id, 'unassigned'),
        testnet: normalizeValue(testnet.nitro?.cvm_id, 'unassigned'),
      },
      {
        label: 'Oracle CVM Name',
        mainnet: normalizeValue(mainnet.nitro?.cvm_name, 'unassigned'),
        testnet: normalizeValue(testnet.nitro?.cvm_name, 'unassigned'),
      },
      {
        label: 'Oracle Attestation Explorer',
        mainnet: normalizeValue(mainnet.nitro?.oracle_attestation_explorer_url, 'unassigned'),
        testnet: normalizeValue(testnet.nitro?.oracle_attestation_explorer_url, 'unassigned'),
      },
      {
        label: 'Datafeed CVM ID',
        mainnet: normalizeValue(mainnet.nitro?.datafeed_cvm_id, 'unassigned'),
        testnet: normalizeValue(testnet.nitro?.datafeed_cvm_id, 'unassigned'),
      },
      {
        label: 'Datafeed CVM Name',
        mainnet: normalizeValue(mainnet.nitro?.datafeed_cvm_name, 'unassigned'),
        testnet: normalizeValue(testnet.nitro?.datafeed_cvm_name, 'unassigned'),
      },
      {
        label: 'Datafeed Attestation Explorer',
        mainnet: normalizeValue(mainnet.nitro?.datafeed_attestation_explorer_url, 'unassigned'),
        testnet: normalizeValue(testnet.nitro?.datafeed_attestation_explorer_url, 'unassigned'),
      },
      {
        label: 'Neo N3 RPC',
        mainnet: normalizeValue(mainnet.neo_n3?.rpc_url, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.rpc_url, 'unassigned'),
      },
      {
        label: 'Neo N3 network magic',
        mainnet: String(mainnet.neo_n3?.network_magic ?? 'unassigned'),
        testnet: String(testnet.neo_n3?.network_magic ?? 'unassigned'),
      },
      {
        label: 'MorpheusOracle',
        mainnet: normalizeValue(mainnet.neo_n3?.contracts?.morpheus_oracle, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.contracts?.morpheus_oracle, 'unassigned'),
      },
      {
        label: 'OracleCallbackConsumer (optional)',
        mainnet: normalizeValue(mainnet.neo_n3?.contracts?.oracle_callback_consumer, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.contracts?.oracle_callback_consumer, 'unassigned'),
      },
      {
        label: 'Example consumer',
        mainnet: normalizeValue(mainnet.neo_n3?.examples?.oracle_callback_consumer, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.examples?.oracle_callback_consumer, 'unassigned'),
      },
      {
        label: 'MorpheusDataFeed',
        mainnet: normalizeValue(mainnet.neo_n3?.contracts?.morpheus_datafeed, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.contracts?.morpheus_datafeed, 'unassigned'),
      },
      {
        label: 'Feed reader example',
        mainnet: normalizeValue(mainnet.neo_n3?.examples?.feed_reader, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.examples?.feed_reader, 'unassigned'),
      },
      {
        label: 'AbstractAccount',
        mainnet: normalizeValue(mainnet.neo_n3?.contracts?.abstract_account, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.contracts?.abstract_account, 'unassigned'),
      },
      {
        label: 'AA runtime label',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_runtime?.display_name, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.aa_runtime?.display_name, 'unassigned'),
      },
      {
        label: 'AA ABI generation',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_runtime?.abi_generation, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.aa_runtime?.abi_generation, 'unassigned'),
      },
      {
        label: 'AA Web3AuthVerifier',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_verifiers?.web3auth, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.aa_verifiers?.web3auth, 'deployment-specific'),
      },
      {
        label: 'AA RecoveryVerifier',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_verifiers?.social_recovery, 'unassigned'),
        testnet: normalizeValue(
          testnet.neo_n3?.aa_verifiers?.social_recovery,
          'deployment-specific'
        ),
      },
      {
        label: 'NeoDIDRegistry',
        mainnet: normalizeValue(mainnet.neo_n3?.contracts?.morpheus_neodid, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.contracts?.morpheus_neodid, 'unpublished'),
      },
      {
        label: 'Oracle NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.domains?.morpheus_oracle, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.domains?.morpheus_oracle, 'unassigned'),
      },
      {
        label: 'DataFeed NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.domains?.morpheus_datafeed, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.domains?.morpheus_datafeed, 'unassigned'),
      },
      {
        label: 'AA NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.domains?.morpheus_aa, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.domains?.morpheus_aa, 'unassigned'),
      },
      {
        label: 'AA Alias NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.domains?.morpheus_aa_alias, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.domains?.morpheus_aa_alias, 'unassigned'),
      },
      {
        label: 'AA Core NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_subdomains?.core, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.aa_subdomains?.core, 'unassigned'),
      },
      {
        label: 'AA Web3Auth NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_subdomains?.web3auth, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.aa_subdomains?.web3auth, 'unassigned'),
      },
      {
        label: 'AA Recovery NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_subdomains?.recovery, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.aa_subdomains?.recovery, 'unassigned'),
      },
      {
        label: 'AA Tee NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_subdomains?.tee, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.aa_subdomains?.tee, 'unassigned'),
      },
      {
        label: 'AA Session NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_subdomains?.session, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.aa_subdomains?.session, 'unassigned'),
      },
      {
        label: 'AA MultiSig NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.aa_subdomains?.multisig, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.aa_subdomains?.multisig, 'unassigned'),
      },
      {
        label: 'NeoDID NNS',
        mainnet: normalizeValue(mainnet.neo_n3?.domains?.morpheus_neodid, 'unassigned'),
        testnet: normalizeValue(testnet.neo_n3?.domains?.morpheus_neodid, 'unassigned'),
      },
    ];
  }, []);

  const handleCopy = (text: string) => {
    if (!text || text === 'unassigned' || text === 'unpublished') return;
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const copyBtn = (text: string) => (
    <button
      onClick={() => handleCopy(text)}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: 'var(--text-muted)',
      }}
      title="Copy value"
      disabled={!text || text === 'unassigned' || text === 'unpublished'}
    >
      {copied === text ? (
        <Check size={14} color="var(--neo-green)" />
      ) : (
        <Copy size={14} className="hover-white" />
      )}
    </button>
  );

  const renderValue = (value: string) => {
    const isEmpty = value === 'unassigned' || value === 'unpublished';
    const isUrl = /^https?:\/\//i.test(value);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {isUrl && !isEmpty ? (
          <a
            href={value}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              color: 'var(--neo-green)',
              textDecoration: 'none',
              wordBreak: 'break-all',
            }}
          >
            <span>{value}</span>
            <ExternalLink size={13} />
          </a>
        ) : (
          <span style={{ color: isEmpty ? 'var(--text-muted)' : 'var(--neo-green)' }}>{value}</span>
        )}
        {copyBtn(value)}
      </div>
    );
  };

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <Globe size={14} color="var(--neo-green)" />
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
          NETWORK REGISTRY
        </span>
      </div>
      <h1>Networks & Contracts</h1>

      <p
        className="lead"
        style={{
          fontSize: '1.1rem',
          color: 'var(--text-primary)',
          marginBottom: '2.5rem',
          lineHeight: 1.7,
        }}
      >
        Canonical mainnet and testnet publication status for NeoOS Oracle (deployed as
        MorpheusOracle), DataFeed, NeoDID, and AA integration anchors. The selected runtime is{' '}
        <code>{selectedKey}</code>, but this page shows both networks side-by-side so addresses and
        domains do not get mixed. Oracle and DataFeed CVMs are shared across both networks; the
        network boundary is path-driven and config-driven rather than VM-driven.
      </p>

      <div
        className="card-industrial"
        style={{
          padding: '1.5rem',
          borderLeft: '4px solid var(--neo-green)',
          marginBottom: '2rem',
        }}
      >
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Source of truth: <code>config/networks/mainnet.json</code> and{' '}
          <code>config/networks/testnet.json</code>. The current role-split Nitro launchers live in{' '}
          <code>nitro.request-hub.toml</code> and <code>nitro.feed-hub.toml</code>, while runtime
          selection happens through <code>/mainnet/*</code> and <code>/testnet/*</code>.
        </p>
      </div>

      <div
        style={{
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-sm)',
          overflow: 'hidden',
          marginBottom: '2rem',
          background: 'var(--bg-panel)',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.84rem',
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
              <th
                style={{ padding: '1rem 1.25rem', color: 'var(--text-primary)', fontWeight: 800 }}
              >
                ITEM
              </th>
              <th
                style={{ padding: '1rem 1.25rem', color: 'var(--text-primary)', fontWeight: 800 }}
              >
                MAINNET
              </th>
              <th
                style={{ padding: '1rem 1.25rem', color: 'var(--text-primary)', fontWeight: 800 }}
              >
                TESTNET
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                <td style={{ padding: '1rem 1.25rem', fontWeight: 700 }}>{row.label}</td>
                <td
                  style={{
                    padding: '1rem 1.25rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.78rem',
                  }}
                >
                  {renderValue(row.mainnet)}
                </td>
                <td
                  style={{
                    padding: '1rem 1.25rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.78rem',
                  }}
                >
                  {renderValue(row.testnet)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        className="card-industrial"
        style={{
          padding: '1.5rem',
          borderLeft: '4px solid var(--accent-blue)',
          marginBottom: '2rem',
        }}
      >
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Interpretation rules:
        </p>
        <ul style={{ marginTop: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          <li>
            <code>OracleCallbackConsumer</code> is an optional external callback adapter published
            in the network registry. The shared kernel inbox is the canonical result path.
          </li>
          <li>
            <code>Example consumer</code> and <code>Feed reader example</code> are validation/demo
            contracts used by the published live probes.
          </li>
          <li>
            <code>AA runtime label</code> is the canonical product name; raw manifest-name suffixes
            stay in low-level deployment logs only.
          </li>
          <li>Oracle and DataFeed CVM ids intentionally match across mainnet and testnet rows.</li>
          <li>
            Mainnet AA ecosystem contracts are now also published under <code>smartwallet.neo</code>{' '}
            subdomains for direct verifier / hook discovery.
          </li>
          <li>
            <code>aa.morpheus.neo</code> is kept as a compatibility alias;{' '}
            <code>smartwallet.neo</code> remains the primary AA public domain.
          </li>
          <li>Testnet AA currently has a published core hash but no NNS alias.</li>
          <li>
            Testnet NeoDIDRegistry remains unpublished in the canonical registry until a stable
            shared deployment is intentionally promoted.
          </li>
        </ul>
      </div>

      <div
        className="card-industrial"
        style={{
          padding: '1.5rem',
          borderLeft: '4px solid var(--neo-green)',
          marginBottom: '2rem',
        }}
      >
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Neo N3 remains the active supported runtime path. The live request fee is{' '}
          <code>0.01 GAS</code>, the confidential payload transport is{' '}
          <code>X25519-HKDF-SHA256-AES-256-GCM</code>, and the public NeoDID service DID is{' '}
          <code>did:morpheus:neo_n3:service:neodid</code>.
        </p>
      </div>
    </div>
  );
}
