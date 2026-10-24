import { randomUUID } from 'node:crypto';
import { buildSignedResultEnvelope, buildLaneSignedEnvelope } from '../chain/index.js';
import {
  env,
  envForNetwork,
  json,
  jsonError,
  normalizeBoolean,
  normalizeMorpheusNetwork,
  normalizeTargetChain,
  parseDurationMs,
  requireHttpsRpcUrl,
  resolvePayloadNetwork,
  trimString,
} from '../platform/core.js';
import {
  persistSponsorshipApproval,
  sponsorshipApprovalDigest,
  transactionSponsorshipEnabled,
} from './approvals.js';

function parseCsv(value) {
  const raw = trimString(value);
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => trimString(entry))
    .filter(Boolean);
}

function normalizeHexHash(value) {
  const raw = trimString(value).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(raw)) return '';
  return `0x${raw}`;
}

export function resolvePaymasterNetwork(payload = {}) {
  const fallback = normalizeMorpheusNetwork(env('MORPHEUS_NETWORK') || 'testnet');
  return resolvePayloadNetwork(payload, fallback);
}

function resolvePaymasterPolicy(network) {
  const upper = network === 'mainnet' ? 'MAINNET' : 'TESTNET';
  return {
    network,
    enabled: normalizeBoolean(env(`MORPHEUS_PAYMASTER_${upper}_ENABLED`), false),
    policyId: trimString(env(`MORPHEUS_PAYMASTER_${upper}_POLICY_ID`) || `${network}-default`),
    maxGasUnits: Number(env(`MORPHEUS_PAYMASTER_${upper}_MAX_GAS_UNITS`) || 0),
    allowTargets: parseCsv(env(`MORPHEUS_PAYMASTER_${upper}_ALLOW_TARGETS`)).map((entry) =>
      entry.toLowerCase()
    ),
    allowUserOpTargets: parseCsv(env(`MORPHEUS_PAYMASTER_${upper}_ALLOW_USEROP_TARGETS`)).map(
      (entry) => entry.toLowerCase()
    ),
    allowMethods: parseCsv(env(`MORPHEUS_PAYMASTER_${upper}_ALLOW_METHODS`)).map((entry) =>
      entry.toLowerCase()
    ),
    allowAccounts: parseCsv(env(`MORPHEUS_PAYMASTER_${upper}_ALLOW_ACCOUNTS`)).map((entry) =>
      entry.toLowerCase()
    ),
    blockAccounts: parseCsv(env(`MORPHEUS_PAYMASTER_${upper}_BLOCK_ACCOUNTS`)).map((entry) =>
      entry.toLowerCase()
    ),
    allowDapps: parseCsv(env(`MORPHEUS_PAYMASTER_${upper}_ALLOW_DAPPS`)).map((entry) =>
      entry.toLowerCase()
    ),
    aaCoreHash: normalizeHexHash(
      env(`MORPHEUS_PAYMASTER_${upper}_AA_CORE_HASH`) || envForNetwork(network, 'AA_CORE_HASH')
    ),
    whitelistHookHash: normalizeHexHash(env(`MORPHEUS_PAYMASTER_${upper}_WHITELIST_HOOK_HASH`)),
    multiHookHash: normalizeHexHash(env(`MORPHEUS_PAYMASTER_${upper}_MULTI_HOOK_HASH`)),
    neoRpcUrl: trimString(
      env(`MORPHEUS_PAYMASTER_${upper}_NEO_RPC_URL`) || envForNetwork(network, 'NEO_RPC_URL')
    ),
    ttlMs: parseDurationMs(env(`MORPHEUS_PAYMASTER_${upper}_TTL_MS`) || '15m', 15 * 60_000),
  };
}

function normalizeVerdictPayload(payload = {}) {
  return {
    account_id: trimString(payload.account_id || payload.accountId || payload.requester || ''),
    dapp_id: trimString(payload.dapp_id || payload.dappId || ''),
    target_contract: trimString(payload.target_contract || payload.targetContract || ''),
    method: trimString(payload.method || payload.target_method || payload.targetMethod || ''),
    userop_target_contract: trimString(
      payload.userop_target_contract || payload.userOpTargetContract || ''
    ),
    userop_method: trimString(payload.userop_method || payload.userOpMethod || ''),
    estimated_gas_units: Number(payload.estimated_gas_units ?? payload.estimatedGasUnits ?? 0),
    operation_hash: trimString(payload.operation_hash || payload.operationHash || ''),
    target_chain: normalizeTargetChain(payload.target_chain || 'neo_n3'),
  };
}

function buildDeniedVerdict(policy, normalized, reason) {
  return {
    mode: 'paymaster_authorize',
    approved: false,
    reason,
    network: policy.network,
    target_chain: normalized.target_chain,
    account_id: normalized.account_id,
    dapp_id: normalized.dapp_id,
    target_contract: normalized.target_contract,
    method: normalized.method,
    userop_target_contract: normalized.userop_target_contract,
    userop_method: normalized.userop_method,
    estimated_gas_units: normalized.estimated_gas_units,
    operation_hash: normalized.operation_hash,
    policy: {
      policy_id: policy.policyId,
      max_gas_units: policy.maxGasUnits,
      allow_targets: policy.allowTargets,
      allow_userop_targets: policy.allowUserOpTargets,
      allow_methods: policy.allowMethods,
      allow_accounts: policy.allowAccounts,
      block_accounts: policy.blockAccounts,
      allow_dapps: policy.allowDapps,
    },
  };
}

async function invokeNeoRead(rpcUrl, contractHash, method, args = []) {
  const response = await fetch(requireHttpsRpcUrl(rpcUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'invokefunction',
      params: [contractHash, method, args],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || `invokefunction ${method} failed`);
  }
  return data.result;
}

function stackItemToValue(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'Boolean') return Boolean(item.value);
  if (item.type === 'ByteString') {
    try {
      return Buffer.from(String(item.value || ''), 'base64').toString('hex');
    } catch {
      return String(item.value || '');
    }
  }
  if (item.type === 'Hash160') {
    return normalizeHexHash(item.value || '');
  }
  if (item.type === 'Array' || item.type === 'Struct') {
    return Array.isArray(item.value) ? item.value.map(stackItemToValue) : [];
  }
  return item.value ?? null;
}

function hash160Arg(value) {
  return { type: 'Hash160', value: normalizeHexHash(value) };
}

async function evaluateOnChainAAPolicy(policy, normalized) {
  if (
    !policy.neoRpcUrl ||
    !policy.aaCoreHash ||
    !normalized.account_id ||
    !normalized.userop_target_contract
  ) {
    return { checked: false, approved: null, reason: 'aa on-chain policy not configured' };
  }

  const hookResult = await invokeNeoRead(policy.neoRpcUrl, policy.aaCoreHash, 'getHook', [
    hash160Arg(normalized.account_id),
  ]);
  const hookHashRaw = stackItemToValue(hookResult?.stack?.[0]);
  const hookHash = normalizeHexHash(hookHashRaw);
  if (!hookHash) {
    return { checked: false, approved: null, reason: 'aa account has no hook configured' };
  }

  let whitelistHook = '';
  if (policy.whitelistHookHash && hookHash === policy.whitelistHookHash) {
    whitelistHook = hookHash;
  } else if (
    policy.multiHookHash &&
    hookHash === policy.multiHookHash &&
    policy.whitelistHookHash
  ) {
    const hooksResult = await invokeNeoRead(policy.neoRpcUrl, hookHash, 'getHooks', [
      hash160Arg(normalized.account_id),
    ]);
    const hooks = Array.isArray(hooksResult?.stack?.[0]?.value)
      ? hooksResult.stack[0].value.map((entry) => normalizeHexHash(stackItemToValue(entry)))
      : [];
    if (hooks.includes(policy.whitelistHookHash)) {
      whitelistHook = policy.whitelistHookHash;
    }
  }

  if (!whitelistHook) {
    return { checked: false, approved: null, reason: 'aa whitelist hook not active for account' };
  }

  const verdictResult = await invokeNeoRead(policy.neoRpcUrl, whitelistHook, 'isWhitelisted', [
    hash160Arg(normalized.account_id),
    hash160Arg(normalized.userop_target_contract),
  ]);
  const approved = Boolean(verdictResult?.stack?.[0]?.value);
  return {
    checked: true,
    approved,
    reason: approved ? '' : 'userop_target_contract is not allowlisted by AA hook',
    hook: whitelistHook,
  };
}

async function evaluatePaymasterAuthorization(payload = {}) {
  const policy = resolvePaymasterPolicy(resolvePaymasterNetwork(payload));
  const normalized = normalizeVerdictPayload(payload);

  const gasUnits = Number(payload.estimated_gas_units);
  if (!Number.isFinite(gasUnits) || gasUnits < 1) {
    return json(400, { error: 'estimated_gas_units must be a positive number' });
  }
  if (!policy.enabled) {
    return buildDeniedVerdict(policy, normalized, 'paymaster disabled for network');
  }
  if (!normalized.account_id) {
    return buildDeniedVerdict(policy, normalized, 'account_id is required');
  }
  if (normalized.target_chain !== 'neo_n3') {
    return buildDeniedVerdict(policy, normalized, 'paymaster currently supports neo_n3 only');
  }
  if (!normalized.operation_hash) {
    return buildDeniedVerdict(policy, normalized, 'operation_hash is required');
  }
  if (!normalized.target_contract) {
    return buildDeniedVerdict(policy, normalized, 'target_contract is required');
  }
  if (!normalized.method) {
    return buildDeniedVerdict(policy, normalized, 'method is required');
  }
  if (policy.maxGasUnits > 0 && normalized.estimated_gas_units > policy.maxGasUnits) {
    return buildDeniedVerdict(policy, normalized, 'estimated gas exceeds network paymaster limit');
  }
  if (
    policy.blockAccounts.length > 0 &&
    policy.blockAccounts.includes(normalized.account_id.toLowerCase())
  ) {
    return buildDeniedVerdict(policy, normalized, 'account_id is blocklisted');
  }
  if (
    policy.allowAccounts.length > 0 &&
    !policy.allowAccounts.includes(normalized.account_id.toLowerCase())
  ) {
    return buildDeniedVerdict(policy, normalized, 'account_id is not allowlisted');
  }
  if (policy.allowDapps.length > 0) {
    if (!normalized.dapp_id) {
      return buildDeniedVerdict(policy, normalized, 'dapp_id is required');
    }
    if (!policy.allowDapps.includes(normalized.dapp_id.toLowerCase())) {
      return buildDeniedVerdict(policy, normalized, 'dapp_id is not allowlisted');
    }
  }
  if (
    policy.allowTargets.length > 0 &&
    !policy.allowTargets.includes(normalized.target_contract.toLowerCase())
  ) {
    return buildDeniedVerdict(policy, normalized, 'target_contract is not allowlisted');
  }
  if (
    policy.allowMethods.length > 0 &&
    !policy.allowMethods.includes(normalized.method.toLowerCase())
  ) {
    return buildDeniedVerdict(policy, normalized, 'method is not allowlisted');
  }

  const isUserOperation = ['executeuserop', 'executeunifiedbyaddress'].includes(
    normalized.method.toLowerCase()
  );
  if (isUserOperation && !normalized.userop_target_contract) {
    return buildDeniedVerdict(policy, normalized, 'userop_target_contract is required');
  }
  if (
    policy.allowUserOpTargets.length > 0 &&
    !policy.allowUserOpTargets.includes(normalized.userop_target_contract.toLowerCase())
  ) {
    return buildDeniedVerdict(policy, normalized, 'userop_target_contract is not allowlisted');
  }

  const requiresOnChainPolicy = Boolean(policy.whitelistHookHash || policy.multiHookHash);
  const onChainPolicy = requiresOnChainPolicy
    ? await evaluateOnChainAAPolicy(policy, normalized)
    : { checked: false, approved: null, reason: 'on-chain AA hook policy not enabled' };
  if (
    normalized.userop_target_contract &&
    policy.allowUserOpTargets.length === 0 &&
    !requiresOnChainPolicy
  ) {
    return buildDeniedVerdict(policy, normalized, 'userop target policy is not configured');
  }
  if (requiresOnChainPolicy && (!onChainPolicy.checked || !onChainPolicy.approved)) {
    return buildDeniedVerdict(
      policy,
      normalized,
      onChainPolicy.checked
        ? onChainPolicy.reason || 'AA hook policy denied sponsorship'
        : `required AA hook policy was not checked: ${onChainPolicy.reason || 'missing context'}`
    );
  }

  return {
    mode: 'paymaster_authorize',
    approved: true,
    network: policy.network,
    target_chain: normalized.target_chain,
    policy_id: policy.policyId,
    sponsorship_id: randomUUID(),
    account_id: normalized.account_id,
    dapp_id: normalized.dapp_id,
    target_contract: normalized.target_contract,
    method: normalized.method,
    userop_target_contract: normalized.userop_target_contract,
    userop_method: normalized.userop_method,
    estimated_gas_units: normalized.estimated_gas_units,
    operation_hash: normalized.operation_hash,
    approval_digest: sponsorshipApprovalDigest({
      ...normalized,
      network: policy.network,
      policy_id: policy.policyId,
    }),
    expires_at: new Date(Date.now() + policy.ttlMs).toISOString(),
    policy: {
      policy_id: policy.policyId,
      max_gas_units: policy.maxGasUnits,
    },
    onchain_policy: onChainPolicy.checked
      ? {
          source: 'aa_hook',
          hook: onChainPolicy.hook || null,
        }
      : null,
  };
}

export async function handlePaymasterAuthorize(payload = {}) {
  try {
    const result = await evaluatePaymasterAuthorization(payload);
    const signed = await buildSignedResultEnvelope(result, payload);
    const response = {
      ...result,
      // D5 canonical signed-result envelope — single-sourced.
      ...buildLaneSignedEnvelope(signed),
    };
    if (result.approved === true && transactionSponsorshipEnabled()) {
      await persistSponsorshipApproval(result);
    }
    // signed.tee_attestation already binds sha256(stableStringify(result)) via output_hash;
    // reuse it rather than re-calling the 8787 /attestation endpoint with the same report_data.
    return json(200, response);
  } catch (error) {
    return jsonError(Number(error?.status) > 0 ? Number(error.status) : 400, error);
  }
}
