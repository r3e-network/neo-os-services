import Link from 'next/link';
import { ClipboardList, ArrowRight, Shield, Cpu, Terminal } from 'lucide-react';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { NETWORKS } from '@/lib/onchain-data';

const oracleTemplates = [
  {
    title: 'Built-in Provider Oracle',
    desc: 'Fastest path for a public quote callback through the Oracle contract.',
    code: `{
 "symbol": "TWELVEDATA:NEO-USD",
 "json_path": "price",
 "target_chain": "neo_n3"
}`,
  },
  {
    title: 'Private API With Encrypted Token',
    desc: 'Best for premium APIs or project-specific endpoints that require auth.',
    code: `{
 "url": "https://api.example.com/private-price",
 "method": "GET",
 "encrypted_token": "<sealed bearer token>",
 "token_header": "Authorization",
 "json_path": "price",
 "target_chain": "neo_n3"
}`,
  },
  {
    title: 'Built-in Provider + Encrypted Payload Patch',
    desc: 'Hide fields such as json_path, project-specific params, or helper settings.',
    code: `{
 "symbol": "TWELVEDATA:BTC-USD",
 "encrypted_payload": "<sealed {\\"json_path\\":\\"price\\",\\"target_chain\\":\\"neo_n3\\"}>"
}`,
  },
  {
    title: 'Custom URL + JS Reduction',
    desc: 'Fetch public data and return only a scalar or boolean to the contract.',
    code: `{
 "url": "<production-api-url>",
 "json_path": "<json-path>",
 "script": "<production-reduction-script>",
 "entry_point": "process",
 "target_chain": "neo_n3"
}`,
  },
];

const computeTemplates = [
  {
    title: 'privacy.mask',
    desc: 'Mask personally identifiable strings before returning them.',
    code: `{
 "mode": "builtin",
 "function": "privacy.mask",
 "input": { "value": "13812345678", "unmasked_left": 3, "unmasked_right": 4 },
 "target_chain": "neo_n3"
}`,
  },
  {
    title: 'math.modexp',
    desc: 'Big integer modular arithmetic for cryptography-heavy workloads.',
    code: `{
 "mode": "builtin",
 "function": "math.modexp",
 "input": { "base": "123456789", "exponent": "987654321", "modulus": "2147483647" },
 "target_chain": "neo_n3"
}`,
  },
  {
    title: 'zkp.public_signal_hash',
    desc: 'Compress large public signal arrays into one digest.',
    code: `{
 "mode": "builtin",
 "function": "zkp.public_signal_hash",
 "input": { "circuit_id": "credit_v1", "signals": ["1", "2", "3"] },
 "target_chain": "neo_n3"
}`,
  },
  {
    title: 'Encrypted Built-in Compute',
    desc: 'Hide both the function name and its input until the job reaches the TEE.',
    code: `{
 "encrypted_payload": "<sealed {\\"mode\\":\\"builtin\\",\\"function\\":\\"math.modexp\\",\\"input\\":{\\"base\\":\\"2\\",\\"exponent\\":\\"10\\",\\"modulus\\":\\"17\\"},\\"target_chain\\":\\"neo_n3\\"}>"
}`,
  },
];

export default function DocsTemplates() {
  const universalConsumer = NETWORKS.neo_n3.exampleConsumer || NETWORKS.neo_n3.callbackConsumer;

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <ClipboardList size={14} color="var(--neo-green)" />
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
          COPY-READY STARTERS
        </span>
      </div>
      <h1>Starter Templates</h1>

      <p
        className="lead"
        style={{
          fontSize: '1.1rem',
          color: 'var(--text-primary)',
          marginBottom: '2.5rem',
          lineHeight: 1.6,
        }}
      >
        These are copy-ready payloads and zero-code testing patterns for users who want to
        participate immediately. Pick a template, encrypt sensitive fields if needed, submit it
        through the Oracle contract, and read the callback.
      </p>

      <div
        className="card-industrial"
        style={{
          padding: '2rem',
          borderLeft: '4px solid var(--neo-green)',
          marginBottom: '2.5rem',
        }}
      >
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
          <Terminal size={20} color="var(--neo-green)" />
          <h3
            style={{
              margin: 0,
              fontSize: '1rem',
              fontWeight: 800,
              color: 'var(--text-primary)',
              textTransform: 'uppercase',
              letterSpacing: 0,
            }}
          >
            Zero-Code {NETWORKS.neo_n3.environmentLabel} Test
          </h3>
        </div>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '0.75rem' }}>
          You can test Morpheus on {NETWORKS.neo_n3.name} without deploying your own contract first.
        </p>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '0.75rem' }}>
          Oracle contract: <code>{NETWORKS.neo_n3.oracle}</code>
        </p>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '0.75rem' }}>
          Optional universal callback adapter: <code>{universalConsumer}</code>
        </p>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 0 }}>
          The shared kernel inbox is canonical. If you still want an external adapter for testing,
          call <code>request(requestType, payload, callbackContract, callbackMethod)</code> with
          callback target <code>{universalConsumer}</code>, callback method{' '}
          <code>onOracleResult</code>, and attach exactly <code>0.01 GAS</code>.
        </p>
      </div>

      <h2>1. Privacy Oracle Templates</h2>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', margin: '2rem 0 3rem' }}
      >
        {oracleTemplates.map((item) => (
          <div key={item.title} className="card-industrial" style={{ padding: '1.75rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                marginBottom: '0.85rem',
              }}
            >
              <Shield size={18} color="var(--neo-green)" />
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>{item.title}</h3>
            </div>
            <p style={{ marginTop: 0, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {item.desc}
            </p>
            <CodeBlock language="json" title={item.title} code={item.code} />
          </div>
        ))}
      </div>

      <h2>2. Privacy Compute Templates</h2>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', margin: '2rem 0 3rem' }}
      >
        {computeTemplates.map((item) => (
          <div key={item.title} className="card-industrial" style={{ padding: '1.75rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                marginBottom: '0.85rem',
              }}
            >
              <Cpu size={18} color="var(--accent-blue)" />
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>{item.title}</h3>
            </div>
            <p style={{ marginTop: 0, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {item.desc}
            </p>
            <CodeBlock language="json" title={item.title} code={item.code} />
          </div>
        ))}
      </div>

      <h2>3. Best Next Steps</h2>
      <div className="grid grid-2" style={{ gap: '1.5rem', marginTop: '2rem' }}>
        <Link
          href="/docs/studio"
          className="card-industrial"
          style={{ padding: '2rem', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              Starter Studio
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
            Use the interactive generator to choose a flow and auto-build the payload and Neo N3
            request snippet.
          </p>
        </Link>
        <Link
          href="/docs/use-cases"
          className="card-industrial"
          style={{ padding: '2rem', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              Use Cases
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
            Read the scenario-level explanation for privacy oracle, private APIs, built-ins, and
            direct user participation.
          </p>
        </Link>
        <Link
          href="/docs/quickstart"
          className="card-industrial"
          style={{ padding: '2rem', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
              Quickstart
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
            Follow the end-to-end Oracle request flow, fee rule, callback target, and readback
            process on {NETWORKS.neo_n3.name}.
          </p>
        </Link>
      </div>
    </div>
  );
}
