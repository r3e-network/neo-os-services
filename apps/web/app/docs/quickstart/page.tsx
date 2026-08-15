import { Zap, ArrowRight, Terminal } from 'lucide-react';
import Link from 'next/link';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { NETWORKS } from '@/lib/onchain-data';

export default function DocsQuickstart() {
  const exampleConsumer = NETWORKS.neo_n3.exampleConsumer || NETWORKS.neo_n3.callbackConsumer;

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <Zap size={14} color="var(--neo-green)" />
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
          GETTING STARTED
        </span>
      </div>
      <h1>Quickstart</h1>

      <p
        className="lead"
        style={{ fontSize: '1.15rem', color: 'var(--text-primary)', marginBottom: '2.5rem' }}
      >
        Integrate the Morpheus Privacy Oracle into your Neo smart contracts in under 5 minutes. This
        guide covers the end-to-end flow from encrypting secrets to reading the TEE-verified result
        on-chain.
      </p>

      <div
        className="card-industrial"
        style={{
          padding: '1.5rem',
          marginBottom: '2rem',
          borderLeft: '4px solid var(--neo-green)',
        }}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '0.75rem' }}
        >
          <Terminal size={18} color="var(--neo-green)" />
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 800,
              color: 'var(--neo-green)',
              textTransform: 'uppercase',
              letterSpacing: 0,
              fontFamily: 'var(--font-mono)',
            }}
          >
            Live Neo N3 Testnet Validation
          </span>
        </div>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '0.85rem' }}>
          The Morpheus paymaster-backed AA relay path has already been validated end-to-end on Neo
          N3 testnet, including account registration, verifier update, paymaster approval, relay
          submission, and on-chain <code>executeUserOp</code> success.
        </p>
        <p
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.85rem',
            marginBottom: '1rem',
          }}
        >
          The paymaster guide links to the latest validated relay transactions on the explorer so
          the reference never goes stale.
        </p>
        <Link
          href="/docs/r/PAYMASTER"
          className="btn btn-secondary btn-sm"
          style={{ textDecoration: 'none' }}
        >
          Open Paymaster Guide <ArrowRight size={14} />
        </Link>
      </div>

      <h2>Step 1: Understand the Data Flow</h2>
      <p>
        The Morpheus network requires an asynchronous request-callback pattern. You must implement a
        callback function in your contract to receive the response.
      </p>

      <h2>Step 2: Seal Your Parameters (Off-Chain)</h2>
      <p>
        Before calling the Oracle contract, encrypt any sensitive API keys or parameters locally.
        The worker&apos;s active X25519 public key is exposed through the frontend proxy and also
        published on-chain in the Oracle registry metadata.
      </p>

      <CodeBlock
        language="javascript"
        title="Encrypt Parameters"
        code={`// 1. Fetch TEE Public Key
const res = await fetch("/api/oracle/public-key");
const { public_key } = await res.json();

// 2. Your confidential injection payload
const secrets = {
 "headers": { "Authorization": "Bearer YOUR_PRIVATE_API_KEY" }
};

// 3. Encrypt locally using X25519 + HKDF-SHA256 + AES-256-GCM
//    (helper signature: encryptJsonWithOraclePublicKey(publicKey, plaintext))
const encryptedBlob = await encryptJsonWithOraclePublicKey(public_key, JSON.stringify(secrets));`}
      />

      <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        For the full sealed-envelope wire format and the migration to HPKE, see the{' '}
        <Link href="/docs/r/HPKE_X25519_MIGRATION">X25519 / HPKE sealing reference</Link>.
      </p>

      <h2>Step 3: Submit On-Chain Request</h2>
      <p>
        Build a JSON payload, then pass that payload bytestring to the Oracle contract. On Neo N3
        the request currently costs <code>0.01 GAS</code> of prepaid credit.
      </p>

      <CodeBlock
        language="csharp"
        title={`MyOracleConsumer.cs (${NETWORKS.neo_n3.name})`}
        code={`// ${NETWORKS.neo_n3.name} Oracle: ${NETWORKS.neo_n3.oracle}
// NeoNS alias: ${NETWORKS.neo_n3.domains.oracle}

public static BigInteger FetchPrivateData(ByteString encryptedBlob)
{
 string payloadJson = "{\\"url\\":\\"https://api.secret.io\\","
 + "\\"encrypted_params\\":\\"" + (string)encryptedBlob + "\\","
 + "\\"json_path\\":\\"data.price\\","
 + "\\"target_chain\\":\\"neo_n3\\"}";

 return (BigInteger)Contract.Call(
 OracleHash,
 "request",
 CallFlags.All,
 "oracle",
 (ByteString)payloadJson,
 Runtime.ExecutingScriptHash,
 "onOracleResult"
 );
}

public static void OnOracleResult(BigInteger requestId, string requestType, bool success, ByteString result, string error)
{
 Storage.Put(Storage.CurrentContext, "last_result", result);
}`}
      />

      <h2>Step 3b: Recover the requestId from the transaction</h2>
      <p>
        Wallet relays only return a <code>{`{ txid }`}</code> — the on-chain <code>requestId</code>{' '}
        is <strong>not</strong> in the relay response. This is the most common integration mistake.
        To correlate your request with its callback, poll <code>getapplicationlog(txid)</code> and
        read the <code>requestId</code> out of the <code>OracleRequested</code> (or{' '}
        <code>MiniAppRequestQueued</code>) notification emitted by the Oracle contract.
      </p>

      <CodeBlock
        language="javascript"
        title="Extract requestId from the request transaction"
        code={`// Poll the application log until the request notification appears.
async function waitForRequestId(rpcClient, txid, timeoutMs = 90000) {
 const deadline = Date.now() + timeoutMs;
 while (Date.now() < deadline) {
  const log = await rpcClient.getApplicationLog(txid).catch(() => null);
  const notification = (log?.executions?.[0]?.notifications || []).find((entry) =>
   ['OracleRequested', 'MiniAppRequestQueued'].includes(entry.eventname)
  );
  // The requestId is the first item in the notification state array.
  const requestId = notification?.state?.value?.[0]?.value ?? null;
  if (requestId) return requestId;
  await new Promise((resolve) => setTimeout(resolve, 3000));
 }
 throw new Error('timed out waiting for the Oracle request notification');
}`}
      />

      <h2>Step 4: Await the Relayer Callback</h2>
      <p>
        Once the transaction is mined, the <strong>Morpheus Relayer</strong> detects the event,
        forwards the encrypted payload to the enclave (AWS Nitro CVM), and then submits a callback
        transaction back to the shared kernel containing the signed result envelope. The kernel
        persists the canonical inbox record first, and optional external callback adapters can
        mirror that result into custom contracts. If the upstream fetch or compute fails, the
        request should still finalize with a failure result instead of being silently dropped.
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
          <Terminal size={20} color="var(--neo-green)" />
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
            Zero-Code Testing ({NETWORKS.neo_n3.environmentLabel})
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
          You don&apos;t need to write or deploy your own contract-specific callback bridge to test
          Morpheus. The selected {NETWORKS.neo_n3.name} optional example callback adapter is{' '}
          <code
            style={{
              color: 'var(--neo-green)',
              background: 'var(--neo-green-dim)',
              padding: '0.2rem 0.5rem',
              borderRadius: 'var(--ns-radius-xs)',
              border: '1px solid rgba(22, 199, 132, 0.2)',
              fontSize: '0.85rem',
              marginLeft: '0.5rem',
            }}
          >
            {exampleConsumer}
          </code>
          .
        </p>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-secondary)',
            marginBottom: '1.5rem',
            lineHeight: 1.6,
          }}
        >
          <strong>1. Submit Request:</strong> Generate your JSON payload using the{' '}
          <strong>Dashboard Oracle Builder</strong>. Then, invoke <code>request</code> on the shared
          kernel contract (<code>{NETWORKS.neo_n3.oracle}</code>) directly using NeoLine or Neo-CLI:
        </p>
        <ul
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-secondary)',
            marginBottom: '1.5rem',
            paddingLeft: '1.5rem',
            lineHeight: 1.6,
          }}
        >
          <li>
            Arg 1 (String): <code>"privacy_oracle"</code> or <code>"compute"</code>
          </li>
          <li>Arg 2 (ByteString): Your generated JSON payload string</li>
          <li>
            Arg 3 (Hash160): <code>{exampleConsumer}</code>
          </li>
          <li>
            Arg 4 (String): <code>"onOracleResult"</code> for the compatibility adapter path
          </li>
          <li style={{ marginTop: '0.5rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Fee:</strong> Attach exactly{' '}
            <code>0.01 GAS</code> to the transaction invocation.
          </li>
        </ul>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-secondary)',
            marginBottom: 0,
            lineHeight: 1.6,
          }}
        >
          <strong>2. Read Result:</strong> Check your transaction to get the <code>requestId</code>.
          Wait about 60 seconds, then read the kernel-managed result path or perform a read-only
          invoke of <code>getCallback(requestId)</code> on the optional adapter script hash above to
          view your completed result envelope.
        </p>
      </div>

      <div className="grid grid-2" style={{ gap: '1.5rem', marginTop: '4rem' }}>
        <Link
          href="/docs/templates"
          className="card-industrial"
          style={{ padding: '2rem', textDecoration: 'none', transition: 'border-color 0.2s' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              STARTER TEMPLATES
            </span>
            <ArrowRight size={18} color="var(--neo-green)" />
          </div>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              marginTop: '1rem',
              marginBottom: 0,
            }}
          >
            Copy ready Oracle and Compute payloads for the selected network and direct user
            participation.
          </p>
        </Link>
        <Link
          href="/docs/api-reference"
          className="card-industrial"
          style={{ padding: '2rem', textDecoration: 'none', transition: 'border-color 0.2s' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              API REFERENCE
            </span>
            <ArrowRight size={18} color="var(--neo-green)" />
          </div>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              marginTop: '1rem',
              marginBottom: 0,
            }}
          >
            View complete smart contract interfaces and TEE SDK methods.
          </p>
        </Link>
        <Link
          href="/docs/compute"
          className="card-industrial"
          style={{ padding: '2rem', textDecoration: 'none', transition: 'border-color 0.2s' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              ENCLAVE COMPUTE
            </span>
            <ArrowRight size={18} color="var(--neo-green)" />
          </div>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              marginTop: '1rem',
              marginBottom: 0,
            }}
          >
            Learn how to run custom JavaScript inside the hardware enclave.
          </p>
        </Link>
      </div>
    </div>
  );
}
