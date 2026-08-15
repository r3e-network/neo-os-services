export const BUILTIN_FUNCTIONS = [
  {
    name: 'hash.sha256',
    category: 'Hash',
    desc: 'Hashes any JSON-serializable payload with SHA-256.',
    params: 'input: any',
    example: "const digest = await morpheus.hash.sha256({ data: '...' });",
  },
  {
    name: 'hash.keccak256',
    category: 'Hash',
    desc: 'Hashes any JSON-serializable payload with Keccak-256.',
    params: 'input: any',
    example: "const digest = await morpheus.hash.keccak256({ data: '...' });",
  },
  {
    name: 'crypto.rsa_verify',
    category: 'Crypto',
    desc: 'Verifies an RSA-SHA256 signature (computationally efficient in TEE).',
    params: 'public_key: string, signature: string, payload: string',
    example: 'const isValid = await morpheus.crypto.rsa_verify(input);',
  },
  {
    name: 'math.modexp',
    category: 'Math',
    desc: 'Performs big integer modular exponentiation.',
    params: 'base: string, exponent: string, modulus: string',
    example:
      "const result = await morpheus.math.modexp({ base: '2', exponent: '10', modulus: '100' });",
  },
  {
    name: 'math.polynomial',
    category: 'Math',
    desc: 'Evaluates a polynomial of arbitrary degree.',
    params: 'coefficients: string[], x: string, modulus?: string',
    example: "const y = await morpheus.math.polynomial({ coefficients: ['1', '0', '1'], x: '2' });",
  },
  {
    name: 'matrix.multiply',
    category: 'Linear Algebra',
    desc: 'Multiplies two dense matrices.',
    params: 'left: number[][], right: number[][]',
    example: 'const matrix = await morpheus.matrix.multiply({ left: [[1,2]], right: [[3],[4]] });',
  },
  {
    name: 'vector.cosine_similarity',
    category: 'Linear Algebra',
    desc: 'Computes cosine similarity between two vectors.',
    params: 'left: number[], right: number[]',
    example: 'const sim = await morpheus.vector.cosine_similarity({ left: [1,0], right: [0,1] });',
  },
  {
    name: 'merkle.root',
    category: 'Merkle',
    desc: 'Builds a SHA-256 Merkle root from a list of leaves.',
    params: 'leaves: string[]',
    example: "const root = await morpheus.merkle.root({ leaves: ['a', 'b', 'c'] });",
  },
  {
    name: 'zkp.public_signal_hash',
    category: 'ZKP',
    desc: 'Computes a deterministic digest over public signals.',
    params: 'circuit_id: string, signals: any[]',
    example:
      "const hash = await morpheus.zkp.public_signal_hash({ circuit_id: '...', signals: [] });",
  },
  {
    name: 'zkp.proof_digest',
    category: 'ZKP',
    desc: 'Computes a deterministic digest over a proof object and optional verifying key.',
    params: 'proof: any, verifying_key?: any',
    example: 'const digest = await morpheus.zkp.proof_digest({ proof, verifying_key });',
  },
  {
    name: 'zkp.witness_digest',
    category: 'ZKP',
    desc: 'Computes a digest over witness material before proving.',
    params: 'witness: any, circuit_id?: string',
    example:
      "const digest = await morpheus.zkp.witness_digest({ witness, circuit_id: '<circuit-id>' });",
  },
  {
    name: 'zkp.groth16.verify',
    category: 'ZKP',
    desc: 'Verifies a Groth16 proof against a verifying key and public signals.',
    params: 'verifying_key: any, public_signals: any[], proof: any',
    example:
      'const verdict = await morpheus.zkp.groth16.verify({ verifying_key, public_signals, proof });',
  },
  {
    name: 'zkp.groth16.prove.plan',
    category: 'ZKP',
    desc: 'Returns a planning estimate for Groth16 proving workloads.',
    params: 'constraints: number, witness_count: number',
    example:
      'const plan = await morpheus.zkp.groth16.prove.plan({ constraints: 120000, witness_count: 4096 });',
  },
  {
    name: 'zkp.plonk.prove.plan',
    category: 'ZKP',
    desc: 'Returns a planning estimate for PLONK proving workloads.',
    params: 'gates: number',
    example: 'const plan = await morpheus.zkp.plonk.prove.plan({ gates: 90000 });',
  },
  {
    name: 'zkp.zerc20.single_withdraw.verify',
    category: 'ZKP',
    desc: 'Checks zERC20 single-withdraw public inputs and can optionally run Groth16 verification.',
    params: 'public_inputs: object, verifying_key: any, proof: any',
    example:
      'const verdict = await morpheus.zkp.zerc20.single_withdraw.verify({ public_inputs, proof, verifying_key });',
  },
  {
    name: 'fhe.batch_plan',
    category: 'FHE',
    desc: 'Builds a ciphertext batching plan.',
    params: 'slot_count: number, ciphertext_count: number',
    example:
      'const plan = await morpheus.fhe.batch_plan({ slot_count: 4096, ciphertext_count: 8 });',
  },
  {
    name: 'fhe.noise_budget_estimate',
    category: 'FHE',
    desc: 'Estimates a rough FHE noise budget.',
    params: 'multiplicative_depth: number, scale_bits: number, modulus_bits: number',
    example:
      'const estimate = await morpheus.fhe.noise_budget_estimate({ multiplicative_depth: 4, scale_bits: 40, modulus_bits: 218 });',
  },
  {
    name: 'fhe.rotation_plan',
    category: 'FHE',
    desc: 'Returns a rotation and key-switch planning summary.',
    params: 'indices: number[]',
    example: 'const plan = await morpheus.fhe.rotation_plan({ indices: [1, 3, -2] });',
  },
  {
    name: 'privacy.mask',
    category: 'Privacy',
    desc: 'Masks a sensitive string, leaving edges visible.',
    params: 'value: string, unmasked_left: number, unmasked_right: number',
    example:
      "const masked = await morpheus.privacy.mask({ value: 'secret_key', unmasked_left: 2, unmasked_right: 2 });",
  },
  {
    name: 'privacy.add_noise',
    category: 'Privacy',
    desc: 'Adds simulated Laplace noise for differential privacy.',
    params: 'value: number, scale: number',
    example: 'const noisy = await morpheus.privacy.add_noise({ value: 100, scale: 1.0 });',
  },
];

export const AUTOMATION_PATTERNS = [
  {
    title: 'Price Threshold Trigger',
    desc: 'Queue a normal Oracle callback job when the synchronized on-chain pricefeed crosses a threshold.',
    trigger: 'On-chain PriceFeed',
    steps: [
      '1. Morpheus syncs pricefeed pairs on Neo N3 every 60 seconds when change >= 0.1%',
      '2. The automation scheduler compares the latest on-chain pair against your threshold',
      '3. If matched, it queues a standard Oracle request and consumes the normal 0.01 GAS fee credit',
    ],
    config: {
      trigger: {
        type: 'price_threshold',
        feed_chain: 'neo_n3',
        pair: 'TWELVEDATA:NEO-USD',
        comparator: 'cross_above',
        threshold: '300',
        cooldown_ms: 300000,
      },
    },
  },
  {
    title: 'Scheduled Maintenance',
    desc: 'Queue Oracle or compute callbacks on a repeating interval with prepaid fee credit.',
    trigger: 'Interval Scheduler',
    steps: [
      '1. Automation registration is submitted through the Oracle contract',
      '2. The scheduler wakes up at the configured interval and queues a normal request',
      '3. The relayer fulfills the callback with the same signed result envelope used by manual requests',
    ],
    config: {
      trigger: {
        type: 'interval',
        interval_ms: 600000,
        start_at: '<future UTC timestamp, e.g. 2026-03-11T00:10:00Z>',
      },
      execution: {
        request_type: 'compute',
        payload: {
          mode: 'builtin',
          function: 'math.modexp',
          input: { base: '2', exponent: '10', modulus: '17' },
          target_chain: 'neo_n3',
        },
      },
    },
  },
];

export const SECURITY_CONCEPTS = [
  {
    title: 'Remote Attestation',
    desc: 'Each result can include hardware-backed TEE evidence with app id, compose hash, instance id, and report-data binding.',
  },
  {
    title: 'X25519 Payload Sealing',
    desc: 'Morpheus uses X25519 key exchange plus HKDF-SHA256 and AES-256-GCM to protect user inputs before they leave the browser.',
  },
  {
    title: 'Sealed Transport Keys',
    desc: 'The Oracle transport key is sealed inside the confidential VM and wrapped by a dstack-derived key so restarts do not rotate user-facing encryption metadata.',
  },
  {
    title: 'Policy-Gated Paymaster',
    desc: 'Morpheus Paymaster is a separate sponsorship service with per-network policy ids, gas caps, target/method allowlists, and optional account or dapp allowlists. It is not coupled to any specific ZKP circuit.',
  },
];

export const CONTRACT_EXAMPLE = `// Neo N3 (selected environment)
[ContractHash("0xf54d8584ef82315c1800373272ab08ae0db2d5ef")]
public class MorpheusOracle : SmartContract
{
    public static extern BigInteger Request(
        string requestType,
        ByteString payload,
        UInt160 callbackContract,
        string callbackMethod
    );
}

public class MyConsumer : SmartContract
{
    public static BigInteger RequestNeoPrice(ByteString encryptedParams)
    {
        string payloadJson = "{\"provider\":\"twelvedata\",\"symbol\":\"TWELVEDATA:NEO-USD\",\"encrypted_params\":\""
            + (string)encryptedParams
            + "\",\"json_path\":\"price\",\"target_chain\":\"neo_n3\"}";
        return (BigInteger)Contract.Call(
            MorpheusOracle.Hash,
            "request",
            CallFlags.All,
            "privacy_oracle",
            (ByteString)payloadJson,
            Runtime.ExecutingScriptHash,
            "onOracleResult"
        );
    }

    public static void OnOracleResult(BigInteger requestId, string requestType, bool success, ByteString result, string error)
    {
        // store raw callback bytes first, parse off-chain when possible
    }
}`;
