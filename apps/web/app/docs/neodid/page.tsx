import { ArrowRight, Fingerprint } from 'lucide-react';
import Link from 'next/link';
import { CodeBlock } from '@/components/ui/CodeBlock';
import {
  DEFAULT_NEODID_AA_DID,
  DEFAULT_NEODID_SERVICE_DID,
  DEFAULT_NEODID_VAULT_DID,
} from '@/lib/neodid-did-common';
import { NETWORKS } from '@/lib/onchain-data';
import { networkRegistry } from '@/lib/networks';

export default function DocsNeoDidPage() {
  return (
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
          NEODID STANDARDIZED
        </span>
      </div>
      <h1>NeoDID</h1>

      <p
        className="lead"
        style={{
          fontSize: '1.1rem',
          color: 'var(--text-primary)',
          marginBottom: '2.5rem',
          lineHeight: 1.7,
        }}
      >
        NeoDID is the Morpheus privacy identity layer for Neo N3. It now has four aligned surfaces:
        an independent N3 registry contract, Oracle-only request types for bind and ticket issuance,
        Web3Auth-backed identity verification inside the TEE, and a public W3C DID resolver for
        service discovery without disclosing private identity material.
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
          Privacy boundary: DID resolution is intentionally public and minimal. It exposes service
          metadata, verifier material, contract anchors, and routing hints. It does{' '}
          <strong>not</strong> expose provider UIDs, raw Web3Auth claims, master nullifiers, action
          nullifiers, encrypted params, or ticket payloads.
        </p>
      </div>

      <h2>Core Model</h2>
      <ul>
        <li>
          <strong>Master Nullifier:</strong> binds a private Web2 identity to a Neo vault account
          without disclosing the provider UID on-chain.
        </li>
        <li>
          <strong>Action Nullifier:</strong> derives a task-specific nullifier so the same person
          can act through disposable accounts without global linkability.
        </li>
        <li>
          <strong>Kernel-Managed Execution:</strong> production binds, action tickets, and recovery
          tickets enter through the shared Morpheus kernel, land in the system inbox, and can also
          be mirrored through optional callback adapters for compatibility.
        </li>
        <li>
          <strong>Public DID Layer:</strong> a resolver exposes the W3C DID document for the service
          namespace and subject namespaces, while keeping private claims private.
        </li>
      </ul>

      <h2>Contracts And Domains</h2>
      <ul>
        <li>
          <strong>MorpheusOracle:</strong> <code>{NETWORKS.neo_n3.oracle}</code> via{' '}
          <code>{NETWORKS.neo_n3.domains.oracle}</code>
        </li>
        <li>
          <strong>NeoDIDRegistry:</strong> <code>{NETWORKS.neo_n3.neodid}</code> via{' '}
          <code>{NETWORKS.neo_n3.domains.neodid}</code>
        </li>
        <li>
          <strong>AbstractAccount:</strong> <code>{NETWORKS.neo_n3.aa}</code> via{' '}
          <code>{NETWORKS.neo_n3.domains.aa}</code>
        </li>
      </ul>

      <div
        className="card-industrial"
        style={{
          padding: '1.5rem',
          borderLeft: '4px solid var(--accent-blue)',
          marginBottom: '2rem',
        }}
      >
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Network anchors are intentionally explicit:
        </p>
        <ul style={{ marginTop: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          <li>
            <strong>Mainnet Oracle:</strong>{' '}
            <code>{networkRegistry.mainnet.neo_n3.contracts.morpheus_oracle}</code> via{' '}
            <code>{networkRegistry.mainnet.neo_n3.domains.morpheus_oracle}</code>
          </li>
          <li>
            <strong>Mainnet NeoDIDRegistry:</strong>{' '}
            <code>{networkRegistry.mainnet.neo_n3.contracts.morpheus_neodid}</code> via{' '}
            <code>{networkRegistry.mainnet.neo_n3.domains.morpheus_neodid}</code>
          </li>
          <li>
            <strong>Mainnet AA:</strong>{' '}
            <code>{networkRegistry.mainnet.neo_n3.contracts.abstract_account}</code> via{' '}
            <code>{networkRegistry.mainnet.neo_n3.domains.morpheus_aa}</code>
          </li>
          <li>
            <strong>Mainnet AA Web3AuthVerifier:</strong>{' '}
            <code>{networkRegistry.mainnet.neo_n3.aa_verifiers.web3auth}</code>
          </li>
          <li>
            <strong>Mainnet AA RecoveryVerifier:</strong>{' '}
            <code>{networkRegistry.mainnet.neo_n3.aa_verifiers.social_recovery}</code>
          </li>
          <li>
            <strong>Testnet Oracle:</strong>{' '}
            <code>{networkRegistry.testnet.neo_n3.contracts.morpheus_oracle}</code>
          </li>
          <li>
            <strong>Testnet AA:</strong>{' '}
            <code>{networkRegistry.testnet.neo_n3.contracts.abstract_account}</code>
          </li>
          <li>
            <strong>Testnet NeoDIDRegistry:</strong> unpublished in the canonical shared registry
            right now
          </li>
        </ul>
        <p
          style={{
            marginTop: '0.85rem',
            marginBottom: 0,
            color: 'var(--text-secondary)',
            lineHeight: 1.7,
          }}
        >
          Public docs use the stable runtime label <code>UnifiedSmartWalletV3</code>. Historical or
          deployment-specific manifest-name suffixes are implementation details, not the canonical
          AA product name.
        </p>
      </div>

      <h2>W3C DID Method</h2>
      <p>
        NeoDID now exposes a W3C-aligned DID method under <code>did:morpheus</code>. The currently
        supported Neo N3 subjects are:
      </p>
      <ul>
        <li>
          <strong>Service DID:</strong> <code>{DEFAULT_NEODID_SERVICE_DID}</code>
        </li>
        <li>
          <strong>Vault DID:</strong> <code>{DEFAULT_NEODID_VAULT_DID}</code>
        </li>
        {DEFAULT_NEODID_AA_DID ? (
          <li>
            <strong>AA DID:</strong> <code>{DEFAULT_NEODID_AA_DID}</code>
          </li>
        ) : null}
      </ul>
      <p>
        The service DID publishes the TEE verification key as a <code>JsonWebKey2020</code>{' '}
        verification method. Vault and AA DIDs resolve to privacy-preserving service endpoints and
        contract anchors, not to raw user claims.
      </p>

      <CodeBlock
        language="bash"
        title="Resolver"
        code={`curl "https://oracle.meshmini.app/mainnet/neodid/resolve?did=${encodeURIComponent(DEFAULT_NEODID_SERVICE_DID)}"`}
      />

      <CodeBlock
        language="json"
        title="GET /mainnet/neodid/resolve?did=did:morpheus:neo_n3:service:neodid"
        code={`{
 "didResolutionMetadata": {
 "contentType": "application/ld+json;profile=\\"https://w3id.org/did-resolution\\""
 },
 "didDocument": {
 "@context": [
 "https://www.w3.org/ns/did/v1",
 "https://w3id.org/security/suites/jws-2020/v1"
 ],
 "id": "${DEFAULT_NEODID_SERVICE_DID}",
 "verificationMethod": [
 {
 "id": "${DEFAULT_NEODID_SERVICE_DID}#tee-verifier",
 "type": "JsonWebKey2020"
 }
 ],
 "service": [
 {
 "id": "${DEFAULT_NEODID_SERVICE_DID}#registry",
 "type": "MorpheusNeoDIDRegistry"
 },
 {
 "id": "${DEFAULT_NEODID_SERVICE_DID}#oracle-entry",
 "type": "MorpheusOracleGateway"
 }
 ]
 },
 "didDocumentMetadata": {
 "canonicalId": "${DEFAULT_NEODID_SERVICE_DID}",
 "network": "neo_n3"
 }
}`}
      />

      <div
        className="card-industrial"
        style={{
          padding: '1.25rem 1.5rem',
          borderLeft: '4px solid var(--accent-blue)',
          marginBottom: '2rem',
        }}
      >
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Interactive entrypoint:{' '}
          <Link href="/launchpad/neodid-resolver" style={{ color: 'var(--neo-green)' }}>
            NeoDID Resolver
          </Link>{' '}
          lets you resolve the full DID resolution object or the raw{' '}
          <code>application/did+ld+json</code> document directly in the browser.
        </p>
      </div>

      <h2>Independent Contract</h2>
      <p>
        NeoDID remains an independent contract module anchored separately from the Oracle gateway:
      </p>
      <CodeBlock
        language="csharp"
        title="NeoDIDRegistry"
        code={`[DisplayName("NeoDIDRegistry")]
public class NeoDIDRegistry : SmartContract
{
 public static UInt160 Admin();
 public static ECPoint Verifier();
 public static void SetAdmin(UInt160 newAdmin);
 public static void SetVerifier(ECPoint publicKey);
 public static void RegisterBinding(UInt160 vaultAccount, string provider, string claimType, string claimValue, ByteString masterNullifier, ByteString metadataHash, ByteString verificationSignature);
 public static void RevokeBinding(UInt160 vaultAccount, string provider, string claimType);
 public static BindingRecord GetBinding(UInt160 vaultAccount, string provider, string claimType);
 public static bool IsMasterNullifierUsed(ByteString masterNullifier);
 public static bool IsActionNullifierUsed(ByteString actionNullifier);
 public static bool UseActionTicket(UInt160 disposableAccount, string actionId, ByteString actionNullifier, ByteString verificationSignature);
}`}
      />

      <h2>Worker Routes</h2>
      <ul>
        <li>
          <code>GET /api/neodid/providers</code>
        </li>
        <li>
          <code>GET /api/neodid/runtime</code>
        </li>
        <li>
          <code>GET /api/neodid/resolve?did=...</code>
        </li>
        <li>
          <code>POST /api/neodid/bind</code>
        </li>
        <li>
          <code>POST /api/neodid/action-ticket</code>
        </li>
        <li>
          <code>POST /api/neodid/recovery-ticket</code>
        </li>
      </ul>

      <h2>Oracle Request Types</h2>
      <p>
        Preferred production usage is on-chain, not direct worker invocation. These request types go
        through the shared kernel. The legacy-compatible path still uses
        <code> MorpheusOracle.request(...)</code> and is fulfilled asynchronously:
      </p>
      <ul>
        <li>
          <code>neodid_bind</code>
        </li>
        <li>
          <code>neodid_action_ticket</code>
        </li>
        <li>
          <code>neodid_recovery_ticket</code>
        </li>
      </ul>

      <h2>Supported Identity Sources</h2>
      <ul>
        <li>
          <code>web3auth</code> with alias <code>w3a</code>
        </li>
        <li>
          <code>twitter</code>
        </li>
        <li>
          <code>github</code>
        </li>
        <li>
          <code>google</code>
        </li>
        <li>
          <code>discord</code>
        </li>
        <li>
          <code>telegram</code>
        </li>
        <li>
          <code>binance</code>
        </li>
        <li>
          <code>okx</code> with alias <code>okex</code>
        </li>
        <li>
          <code>email</code>
        </li>
      </ul>

      <div
        className="card-industrial"
        style={{
          padding: '1.25rem 1.5rem',
          borderLeft: '4px solid var(--neo-green)',
          marginBottom: '2rem',
        }}
      >
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Recommended AA integration: treat <code>web3auth</code> as the DID root. Link Google /
          Apple / email / SMS / other social providers inside Web3Auth first, then pass the
          resulting <code>id_token</code> to NeoDID. The TEE verifies the JWT against the configured
          JWKS, derives the stable provider root internally, and emits a ticket that AA verifiers
          can consume without knowing the underlying login method.
        </p>
      </div>

      <h2>Web3Auth-In-TEE Path</h2>
      <p>
        The TEE now verifies the Web3Auth JWT directly against the configured JWKS and audience.
        This means the worker derives <code>provider_uid</code> inside the enclave instead of
        trusting a user-supplied identifier.
      </p>
      <CodeBlock
        language="json"
        title="POST /api/neodid/bind (provider = web3auth)"
        code={`{
 "vault_account": "0x6d0656f6dd91469db1c90cc1e574380613f43738",
 "provider": "web3auth",
 "id_token": "<web3auth jwt>",
 "claim_type": "Web3Auth_PrimaryIdentity",
 "claim_value": "linked_social_root"
}`}
      />

      <h2>Large JWT Oracle Flow</h2>
      <p>
        Large Web3Auth JWTs should be sealed locally, stored as ciphertext, and referenced on-chain
        with <code>encrypted_params_ref</code>
        so the Oracle notification payload stays short enough for Neo N3.
      </p>
      <CodeBlock
        language="json"
        title="POST /api/confidential/store"
        code={`{
 "ciphertext": "<sealed id_token patch>",
 "target_chain": "neo_n3",
 "metadata": {
 "source": "web3auth-live-studio"
 }
}`}
      />
      <CodeBlock
        language="json"
        title="Oracle payload using encrypted_params_ref"
        code={`{
 "vault_account": "0x6d0656f6dd91469db1c90cc1e574380613f43738",
 "provider": "web3auth",
 "claim_type": "Web3Auth_PrimaryIdentity",
 "claim_value": "linked_social_root_oracle_ref",
 "encrypted_params_ref": "<secret_ref>"
}`}
      />

      <h2>Action Ticket Example</h2>
      <CodeBlock
        language="json"
        title="POST /api/neodid/action-ticket"
        code={`{
 "provider": "binance",
 "provider_uid": "binance_uid_12345",
 "disposable_account": "0x89b05cac00804648c666b47ecb1c57bc185821b7",
 "action_id": "Airdrop_Season_1"
}`}
      />

      <h2>AA Recovery Ticket Example</h2>
      <CodeBlock
        language="json"
        title="POST /api/neodid/recovery-ticket"
        code={`{
 "provider": "web3auth",
 "network": "neo_n3",
 "aa_contract": "${networkRegistry.mainnet.neo_n3.contracts.abstract_account}",
 "verifier_contract": "${networkRegistry.mainnet.neo_n3.aa_verifiers.social_recovery}",
 "account_id": "<aa-account-id>",
 "new_owner": "0x89b05cac00804648c666b47ecb1c57bc185821b7",
 "recovery_nonce": "7",
 "expires_at": "1735689600",
 "encrypted_params": "<sealed id_token / linked account patch>"
}`}
      />

      <h2>Third-Party Contract Pattern</h2>
      <CodeBlock
        language="csharp"
        title="DApp Ticket Consumption"
        code={`public static bool Vote(UInt160 disposableAccount, string actionId, ByteString actionNullifier, ByteString sgxSignature)
{
 ExecutionEngine.Assert(Runtime.CheckWitness(disposableAccount), "Unauthorized");

 bool accepted = (bool)Contract.Call(
 NeoDidRegistryHash,
 "useActionTicket",
 CallFlags.All,
 disposableAccount,
 actionId,
 actionNullifier,
 sgxSignature
 );

 ExecutionEngine.Assert(accepted, "Invalid NeoDID action ticket");
 return true;
}`}
      />

      <div className="grid grid-2" style={{ gap: '1.5rem', marginTop: '2.5rem' }}>
        <Link
          href="/launchpad/neodid-resolver"
          className="card-industrial"
          style={{ padding: '1.75rem', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              Resolver
            </span>
            <ArrowRight size={18} color="var(--neo-green)" />
          </div>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.85rem', marginBottom: 0 }}>
            Resolve the public DID layer for the service, a vault subject, or an AA namespace.
          </p>
        </Link>
        <Link
          href="/launchpad/neodid-live"
          className="card-industrial"
          style={{ padding: '1.75rem', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              Web3Auth Live
            </span>
            <ArrowRight size={18} color="var(--neo-green)" />
          </div>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.85rem', marginBottom: 0 }}>
            Sign in, fetch a real Web3Auth JWT, locally seal it with X25519, and prepare the Oracle
            payload with <code>encrypted_params_ref</code>.
          </p>
        </Link>
        <Link
          href="/docs/r/NEODID_DID_METHOD"
          className="card-industrial"
          style={{ padding: '1.75rem', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              DID Method Spec
            </span>
            <ArrowRight size={18} color="var(--neo-green)" />
          </div>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.85rem', marginBottom: 0 }}>
            Read the formal method syntax, resolution rules, privacy model, and interoperability
            constraints.
          </p>
        </Link>
        <Link
          href="/docs/r/AA_SOCIAL_RECOVERY"
          className="card-industrial"
          style={{ padding: '1.75rem', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              AA Recovery Spec
            </span>
            <ArrowRight size={18} color="var(--neo-green)" />
          </div>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.85rem', marginBottom: 0 }}>
            Read the recovery ticket schema, verifier checks, timelock flow, and confidentiality
            model for Abstract Account recovery.
          </p>
        </Link>
      </div>
    </div>
  );
}
