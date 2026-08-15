import { Shield, Zap } from 'lucide-react';
import Link from 'next/link';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { NETWORKS } from '@/lib/onchain-data';

export default function DocsOracle() {
  const oracleDomain = NETWORKS.neo_n3.domains.oracle || 'unassigned';

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <Shield size={14} color="var(--neo-green)" />
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 800,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: 0,
            fontFamily: 'var(--font-mono)',
          }}
        >
          CORE SERVICE
        </span>
      </div>
      <h1>Privacy Oracle</h1>

      <p>
        The Morpheus Privacy Oracle allows smart contracts to request off-chain data from any
        HTTP(S) source with end-to-end encryption. Unlike public oracles, Morpheus ensures that API
        keys, auth tokens, and sensitive parameters are never exposed on-chain or to the
        infrastructure operator.
      </p>

      <div
        style={{
          padding: '1.25rem 1.5rem',
          background: 'var(--bg-panel)',
          borderLeft: '4px solid var(--neo-green)',
          borderTop: '1px solid var(--border-dim)',
          borderRight: '1px solid var(--border-dim)',
          borderBottom: '1px solid var(--border-dim)',
          borderRadius: '0 4px 4px 0',
          margin: '2rem 0',
        }}
      >
        <p
          style={{
            margin: 0,
            color: 'var(--text-secondary)',
            fontSize: '0.92rem',
            lineHeight: 1.7,
          }}
        >
          End users should <strong>not</strong> call the worker endpoints directly. The supported
          production path is: encrypt locally, submit the JSON payload through the on-chain Oracle
          contract, and wait for the callback.
          {NETWORKS.neo_n3.name} Oracle: <code>{NETWORKS.neo_n3.oracle}</code> via{' '}
          <code>{oracleDomain}</code>.
        </p>
      </div>

      <h2>Request Lifecycle</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', margin: '2.5rem 0' }}>
        {[
          {
            step: '1',
            title: 'Parameter Sealing',
            desc: 'User dApp encrypts secret parts of the request (e.g., API keys) locally using the Oracle X25519 public key.',
          },
          {
            step: '2',
            title: 'On-Chain Submission',
            desc: 'User contract submits requestType + payload bytes to MorpheusOracle and pays or sponsors the request fee.',
          },
          {
            step: '3',
            title: 'Enclave Execution',
            desc: 'The worker receives the request through the relayer, unseals the data inside the TEE, performs the fetch, and signs the result.',
          },
          {
            step: '4',
            title: 'Verified Callback',
            desc: "The Relayer submits the TEE-signed result back to the user's contract via a callback function.",
          },
        ].map((item, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: '1.5rem',
              padding: '1.25rem',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <div
              style={{
                color: 'var(--neo-green)',
                fontWeight: 900,
                fontSize: '1rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {item.step}
            </div>
            <div>
              <h4
                style={{
                  fontSize: '0.9rem',
                  fontWeight: 800,
                  marginBottom: '0.25rem',
                  color: 'var(--text-primary)',
                }}
              >
                {item.title}
              </h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
                {item.desc}
              </p>
            </div>
          </div>
        ))}
      </div>

      <h2>Data Sealing (Parameter Encryption)</h2>
      <p>
        To ensure API keys, authentication tokens, and private identifiers never leak on-chain,
        Morpheus provides a zero-knowledge parameter sealing mechanism. You encrypt the sensitive
        parts of your request locally.
      </p>

      <div
        style={{
          padding: '1.5rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-md)',
          margin: '2rem 0',
        }}
      >
        <h4
          style={{
            fontSize: '0.85rem',
            fontWeight: 800,
            color: 'var(--text-primary)',
            marginBottom: '1rem',
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}
        >
          1. Structure your Confidential JSON
        </h4>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          The encrypted patch is merged into the public payload inside the TEE. Common confidential
          fields include <code>headers</code>, <code>query</code>, <code>body</code>,{' '}
          <code>json_path</code>, and even <code>script</code>.
        </p>
        <CodeBlock
          language="json"
          code={`{
 "headers": {
 "Authorization": "Bearer sk_live_123456789",
 "X-Project-ID": "proj_xyz"
 },
 "query": {
 "private_customer_id": "cust_999"
 },
 "json_path": "data.score"
}`}
        />
      </div>

      <div
        style={{
          padding: '1.5rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-md)',
          margin: '2rem 0',
        }}
      >
        <h4
          style={{
            fontSize: '0.85rem',
            fontWeight: 800,
            color: 'var(--text-primary)',
            marginBottom: '1rem',
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}
        >
          2. Encrypt Locally (X25519)
        </h4>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          Fetch the Oracle's current public key and encrypt the JSON string. This operation happens
          entirely on the client side.
        </p>
        <CodeBlock
          language="javascript"
          code={`// 1. Fetch TEE Public Key
const { public_key } = await fetch("/api/oracle/public-key").then(r => r.json());

// 2. Encrypt the Confidential JSON
//    (helper signature: encryptJsonWithOraclePublicKey(publicKey, plaintext))
const ciphertext = await encryptJsonWithOraclePublicKey(public_key, JSON.stringify(secrets));
// Returns a Base64 encoded encrypted blob: "vF9+kx..."`}
        />
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '0.85rem' }}>
          See the <Link href="/docs/r/HPKE_X25519_MIGRATION">X25519 / HPKE sealing reference</Link>{' '}
          for the full sealed-envelope wire format.
        </p>
      </div>

      <div
        style={{
          padding: '1.5rem',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-md)',
          margin: '2rem 0',
        }}
      >
        <h4
          style={{
            fontSize: '0.85rem',
            fontWeight: 800,
            color: 'var(--text-primary)',
            marginBottom: '1rem',
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}
        >
          3. Resolve Scripts by Reference
        </h4>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          If the request script is too large for an on-chain payload, store it in a Neo N3 contract
          getter and pass a compact <code>script_ref</code> instead of the full source.
        </p>
        <CodeBlock
          language="json"
          code={`{
 "url": "https://api.example.com/private",
 "script_ref": {
 "contract_hash": "<production-script-registry-hash>",
 "method": "getScript",
 "script_name": "scoreGate"
 },
 "target_chain": "neo_n3"
}`}
        />
      </div>

      <h2>Smart Contract Integration</h2>
      <p>
        Now, place the encrypted blob into the JSON payload that your contract submits on-chain. The
        relayer delivers it to the TEE, which decrypts the blob using the sealed transport key,
        executes the request, and returns the callback envelope.
      </p>

      <div style={{ margin: '2.5rem 0' }}>
        <h3 style={{ fontSize: '1rem', marginTop: 0 }}>Neo N3 (C#)</h3>
        <CodeBlock
          language="csharp"
          code={`public static BigInteger RequestData(ByteString encryptedParams) {
 string payloadJson =
 "{\"symbol\":\"TWELVEDATA:NEO-USD\",\"encrypted_params\":\""
 + (string)encryptedParams
 + "\",\"json_path\":\"price\",\"target_chain\":\"neo_n3\"}";

 return (BigInteger)Contract.Call(
 OracleHash,
 "request",
 CallFlags.All,
 "privacy_oracle",
 (ByteString)payloadJson,
 Runtime.ExecutingScriptHash,
 "onOracleResult"
 );
}`}
        />
        <div
          className="card-industrial"
          style={{
            marginTop: '1.5rem',
            padding: '1.25rem 1.5rem',
            borderLeft: '4px solid var(--accent-blue)',
          }}
        >
          <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            Public integration guidance is intentionally limited to Neo N3.
          </p>
        </div>
      </div>

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
          <Zap size={20} color="var(--neo-green)" />
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
            Transformation Logic
          </h4>
        </div>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-secondary)',
            marginBottom: '1rem',
            lineHeight: 1.6,
          }}
        >
          Instead of using only a static <code>json_path</code> like <code>"price"</code>, you can
          embed a full Javascript function or WASM module <strong>inside the JSON payload</strong>.
          That logic executes inside the TEE after the HTTP fetch completes and only the derived
          result is returned.
        </p>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-secondary)',
            marginBottom: 0,
            lineHeight: 1.6,
            paddingBottom: '0.5rem',
            borderTop: '1px solid rgba(83, 58, 253, 0.1)',
            paddingTop: '1rem',
          }}
        >
          <strong>Advanced Mapping:</strong> Oracle custom JS functions use{' '}
          <code>process(data, context, helpers)</code>. The HTTP body is passed as <code>data</code>
          , request metadata is passed as <code>context</code>, and helper functions are passed as{' '}
          <code>helpers</code>. For stronger isolation, use{' '}
          <a href="/docs/compute" style={{ color: 'var(--neo-green)', textDecoration: 'none' }}>
            WASM
          </a>
          . Upstream response bodies and programmable inputs are also size-bounded to reduce DoS
          risk.
        </p>
      </div>
    </div>
  );
}
