const TIMELOCK_METHODS = Object.freeze({
  verification: Object.freeze({
    propose: 'proposeRuntimeVerificationPublicKey',
    execute: 'executeRuntimeVerificationPublicKey',
    cancel: 'cancelRuntimeVerificationPublicKey',
    eta: 'pendingRuntimeVerificationKeyEta',
  }),
  encryption: Object.freeze({
    propose: 'proposeRuntimeEncryptionKey',
    execute: 'executeRuntimeEncryptionKey',
    cancel: 'cancelRuntimeEncryptionKey',
    eta: 'pendingRuntimeEncryptionKeyEta',
  }),
});

export function oracleKeyTimelockMethods(kind) {
  const methods = TIMELOCK_METHODS[kind];
  if (!methods) throw new Error(`unknown oracle key kind: ${kind}`);
  return methods;
}

export function assertOracleKeyTimelockAbi(state, kind) {
  const expected = oracleKeyTimelockMethods(kind);
  if (state?.manifest?.name !== 'MorpheusOracle') {
    throw new Error('deployed Oracle manifest name is not MorpheusOracle');
  }
  const deployed = Array.isArray(state?.manifest?.abi?.methods) ? state.manifest.abi.methods : null;
  if (!deployed) {
    throw new Error(
      `deployed Oracle ABI has no 24h timelock for ${kind} key; ABI methods are missing`
    );
  }
  const names = new Set(deployed.map((method) => method?.name).filter(Boolean));
  const missing = Object.values(expected).filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `deployed Oracle ABI has no 24h timelock for ${kind} key; missing ${missing.join(', ')}`
    );
  }
  return { kind, ...expected };
}

export async function readOracleContractState(rpcUrl, contractHash, fetchImpl = globalThis.fetch) {
  const normalizedContractHash = String(contractHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalizedContractHash)) {
    throw new Error('timelock ABI probe requires a 20-byte contract hash');
  }
  const requestId = 'neoos-oracle-timelock-probe';
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'getcontractstate',
      params: [normalizedContractHash],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`timelock ABI probe HTTP ${response.status}`);
  const body = await response.json();
  if (body?.jsonrpc !== '2.0' || body?.id !== requestId) {
    throw new Error('timelock ABI probe returned a mismatched JSON-RPC response');
  }
  if (body?.error) throw new Error(`timelock ABI probe RPC error: ${JSON.stringify(body.error)}`);
  if (!body?.result) throw new Error('timelock ABI probe returned no contract state');
  if (String(body.result.hash || '').toLowerCase() !== normalizedContractHash) {
    throw new Error('timelock ABI probe returned state for a different contract hash');
  }
  return body.result;
}
