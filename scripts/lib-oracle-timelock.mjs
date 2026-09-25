const TIMELOCK_METHODS = Object.freeze({
  verification: Object.freeze({
    propose: Object.freeze({
      name: 'proposeRuntimeVerificationPublicKey',
      parameters: [{ name: 'publicKey', type: 'PublicKey' }],
      returntype: 'Void',
      safe: false,
    }),
    execute: Object.freeze({
      name: 'executeRuntimeVerificationPublicKey',
      parameters: [],
      returntype: 'Void',
      safe: false,
    }),
    cancel: Object.freeze({
      name: 'cancelRuntimeVerificationPublicKey',
      parameters: [],
      returntype: 'Void',
      safe: false,
    }),
    eta: Object.freeze({
      name: 'pendingRuntimeVerificationKeyEta',
      parameters: [],
      returntype: 'Integer',
      safe: true,
    }),
  }),
  encryption: Object.freeze({
    propose: Object.freeze({
      name: 'proposeRuntimeEncryptionKey',
      parameters: [
        { name: 'algorithm', type: 'String' },
        { name: 'publicKey', type: 'String' },
      ],
      returntype: 'Void',
      safe: false,
    }),
    execute: Object.freeze({
      name: 'executeRuntimeEncryptionKey',
      parameters: [],
      returntype: 'Void',
      safe: false,
    }),
    cancel: Object.freeze({
      name: 'cancelRuntimeEncryptionKey',
      parameters: [],
      returntype: 'Void',
      safe: false,
    }),
    eta: Object.freeze({
      name: 'pendingRuntimeEncryptionKeyEta',
      parameters: [],
      returntype: 'Integer',
      safe: true,
    }),
  }),
});

export function oracleKeyTimelockMethods(kind) {
  const methods = TIMELOCK_METHODS[kind];
  if (!methods) throw new Error(`unknown oracle key kind: ${kind}`);
  return Object.fromEntries(Object.entries(methods).map(([role, method]) => [role, method.name]));
}

export function resolveOracleAdminWif(env = process.env) {
  const wif = (env.MORPHEUS_ORACLE_ADMIN_WIF || env.NEO_N3_ADMIN_WIF || '').trim();
  if (!wif) {
    throw new Error(
      'MORPHEUS_ORACLE_ADMIN_WIF (or NEO_N3_ADMIN_WIF) is required; the updater key is not an admin substitute'
    );
  }
  return wif;
}

export function assertOracleKeyTimelockAbi(state, kind) {
  const expected = TIMELOCK_METHODS[kind];
  if (!expected) throw new Error(`unknown oracle key kind: ${kind}`);
  if (state?.manifest?.name !== 'MorpheusOracle') {
    throw new Error('deployed Oracle manifest name is not MorpheusOracle');
  }
  const methods = Array.isArray(state?.manifest?.abi?.methods) ? state.manifest.abi.methods : null;
  if (!methods) {
    throw new Error(
      `deployed Oracle ABI has no 24h timelock for ${kind} key; ABI methods are missing`
    );
  }
  const malformedIndex = methods.findIndex(
    (method) =>
      !method ||
      typeof method.name !== 'string' ||
      !method.name ||
      !Array.isArray(method.parameters) ||
      typeof method.returntype !== 'string' ||
      typeof method.safe !== 'boolean' ||
      method.parameters.some(
        (parameter) =>
          !parameter ||
          typeof parameter.name !== 'string' ||
          !parameter.name ||
          typeof parameter.type !== 'string' ||
          !parameter.type
      )
  );
  if (malformedIndex !== -1) {
    throw new Error(
      `deployed Oracle ABI contains a malformed method entry at index ${malformedIndex}`
    );
  }
  const seen = new Set();
  const duplicates = new Set();
  for (const method of methods) {
    if (seen.has(method.name)) duplicates.add(method.name);
    seen.add(method.name);
  }
  if (duplicates.size > 0) {
    throw new Error(`deployed Oracle ABI has duplicate ABI method ${[...duplicates].join(', ')}`);
  }
  const byName = new Map(methods.map((method) => [method.name, method]));
  const missing = Object.values(expected)
    .filter((definition) => !byName.has(definition.name))
    .map((definition) => definition.name);
  if (missing.length > 0) {
    throw new Error(
      `deployed Oracle ABI has no 24h timelock for ${kind} key; missing ${missing.join(', ')}`
    );
  }
  for (const definition of Object.values(expected)) {
    const actual = byName.get(definition.name);
    const actualParameters = Array.isArray(actual.parameters) ? actual.parameters : null;
    const expectedParameters = definition.parameters;
    const parametersMatch =
      actualParameters &&
      actualParameters.length === expectedParameters.length &&
      actualParameters.every(
        (parameter, index) =>
          parameter?.name === expectedParameters[index].name &&
          parameter?.type === expectedParameters[index].type
      );
    const actualTypes = actualParameters
      ? actualParameters.map((parameter) => parameter?.type)
      : null;
    if (
      actual.returntype !== definition.returntype ||
      actual.safe !== definition.safe ||
      !actualTypes ||
      !parametersMatch
    ) {
      throw new Error(
        `deployed Oracle ABI mismatch for ${kind} key timelock method ${definition.name}`
      );
    }
  }
  return { kind, ...oracleKeyTimelockMethods(kind) };
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
