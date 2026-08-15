import { Cpu, Terminal, FileCode, ShieldAlert } from 'lucide-react';
import { CodeBlock } from '@/components/ui/CodeBlock';

export default function DocsCompute() {
  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
        <Cpu size={14} color="var(--accent-blue)" />
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
          EXTENDED SERVICE
        </span>
      </div>
      <h1>Enclave Compute</h1>

      <p>
        Morpheus Enclave Compute allows developers to execute complex, non-deterministic, or
        proprietary logic inside a Trusted Execution Environment. The network supports multiple
        runtimes, ensuring that inputs and intermediate states are never visible to the public
        blockchain.
      </p>

      <h2>Supported Runtimes</h2>
      <div className="grid grid-2" style={{ gap: '1.5rem', margin: '2.5rem 0' }}>
        <div
          style={{
            padding: '1.5rem',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-dim)',
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
            <Terminal size={16} color="var(--neo-green)" />
            <h4
              style={{
                fontSize: '0.9rem',
                fontWeight: 800,
                margin: 0,
                color: 'var(--text-primary)',
                textTransform: 'uppercase',
                letterSpacing: 0,
              }}
            >
              Javascript (QuickJS)
            </h4>
          </div>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              marginBottom: 0,
              lineHeight: 1.6,
            }}
          >
            High-level scripting for data aggregation, custom API parsing, and business logic.
          </p>
        </div>
        <div
          style={{
            padding: '1.5rem',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-dim)',
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
            <FileCode size={16} color="var(--accent-blue)" />
            <h4
              style={{
                fontSize: '0.9rem',
                fontWeight: 800,
                margin: 0,
                color: 'var(--text-primary)',
                textTransform: 'uppercase',
                letterSpacing: 0,
              }}
            >
              WebAssembly (WASM)
            </h4>
          </div>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              marginBottom: 0,
              lineHeight: 1.6,
            }}
          >
            Performance-critical tasks like ZKP witness generation or complex mathematical models.
          </p>
        </div>
      </div>

      <h2>Built-in Capabilities</h2>
      <p>
        The TEE environment provides a global <code>morpheus</code> object with optimized
        cryptographic and utility functions:
      </p>
      <ul>
        <li>
          <strong>Hashing:</strong> SHA-256 and Keccak-256 for integrity checks.
        </li>
        <li>
          <strong>Verification:</strong> High-performance RSA signature verification.
        </li>
        <li>
          <strong>Planning:</strong> ZKP and FHE planning helpers for witness, proof, batching, and
          rotation workflows.
        </li>
        <li>
          <strong>Linear Algebra:</strong> Optimized matrix and vector operations.
        </li>
        <li>
          <strong>Privacy:</strong> Masking and noise helpers for privacy-preserving
          post-processing.
        </li>
      </ul>

      <h2>Handling Confidential Arguments</h2>
      <p>
        When you dispatch a compute job, the encrypted blob you sealed locally is decrypted by the
        TEE core and merged into the final compute payload. For custom JS compute, your entry point
        receives <code>input</code> and <code>helpers</code>, not a live network client.
      </p>

      <CodeBlock
        language="javascript"
        title="Custom Compute Script"
        code={`function process(input, helpers) {
 const values = Array.isArray(input.values) ? input.values : [];
 const total = values.reduce((sum, value) => sum + Number(value || 0), 0);
 return {
 total,
 count: values.length,
 generated_at: helpers.getCurrentTimestamp(),
 };
}`}
      />

      <h2>Contract-Backed Script Registry</h2>
      <p>
        If an inline script would make the request payload too large, you can store the script body
        in a Neo N3 contract getter and send only a compact <code>script_ref</code>. Morpheus
        resolves the script on-chain, then applies the same sandbox, timeout, and size checks before
        execution.
      </p>

      <CodeBlock
        language="json"
        title="script_ref Payload"
        code={`{
 "mode": "script",
 "script_ref": {
 "contract_hash": "<production-script-registry-hash>",
 "method": "getScript",
 "script_name": "sum"
 },
 "entry_point": "process",
 "input": { "a": 2, "b": 3 },
 "target_chain": "neo_n3"
}`}
      />

      <h2>Security Model</h2>
      <p>
        Compute tasks are strictly time-bounded (default 30s timeout) and executed in a stateless
        enclave instance. Any data required for the next execution cycle must be stored back on the
        blockchain via the callback mechanism.
      </p>

      <p>
        The current runtime also enforces input-size, result-size, and upstream body-size ceilings
        to reduce DoS risk from oversized user payloads or oversized fetch/script outputs.
      </p>

      <div
        style={{
          marginTop: '4rem',
          padding: '2rem',
          background: 'var(--bg-panel)',
          borderTop: '1px solid rgba(239, 68, 68, 0.2)',
          borderRight: '1px solid rgba(239, 68, 68, 0.2)',
          borderBottom: '1px solid rgba(239, 68, 68, 0.2)',
          borderLeft: '4px solid var(--error)',
          borderRadius: '0 4px 4px 0',
        }}
      >
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
          <ShieldAlert size={20} color="var(--error)" />
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
            Untrusted Scripts
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
          Direct JS execution requires <code>MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS=true</code>.
          Production deployments should prefer built-in functions or WASM when stronger isolation
          and tighter runtime control are required.
        </p>
      </div>
    </div>
  );
}
