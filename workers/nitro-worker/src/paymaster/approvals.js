import { env, normalizeBoolean, sha256Hex, stableStringify, trimString } from '../platform/core.js';
import {
  upstashGetJsonRequired,
  upstashSetJsonOnceRequired,
  upstashTakeJsonRequired,
} from '../platform/upstash.js';

const SPONSORSHIP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const APPROVAL_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

export function transactionSponsorshipEnabled() {
  return normalizeBoolean(env('MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP'), false);
}

export function sponsorshipApprovalDigest(approval = {}) {
  return sha256Hex({
    network: approval.network,
    policy_id: approval.policy_id,
    account_id: approval.account_id,
    dapp_id: approval.dapp_id,
    target_contract: approval.target_contract,
    method: approval.method,
    userop_target_contract: approval.userop_target_contract,
    userop_method: approval.userop_method,
    estimated_gas_units: approval.estimated_gas_units,
    operation_hash: approval.operation_hash,
  });
}

function sponsorshipId(value) {
  const id = trimString(value);
  if (!SPONSORSHIP_ID_PATTERN.test(id)) {
    throw new Error('sponsorship_id is required and must contain only safe ASCII characters');
  }
  return id;
}

function approvalKey(id) {
  return `morpheus:paymaster:approval:${sponsorshipId(id)}`;
}

export function assertSponsorshipApproval(approval, { id = '', network = '' } = {}) {
  if (!approval || approval.approved !== true || approval.mode !== 'paymaster_authorize') {
    throw new Error('stored sponsorship approval is not an approved paymaster result');
  }
  const approvalId = sponsorshipId(approval.sponsorship_id);
  if (id && approvalId !== sponsorshipId(id)) {
    throw new Error('sponsorship_id does not match the stored approval');
  }
  if (approval.target_chain !== 'neo_n3') {
    throw new Error('sponsorship approval target_chain does not match Neo N3 relay');
  }
  if (network && trimString(approval.network).toLowerCase() !== trimString(network).toLowerCase()) {
    throw new Error('sponsorship approval network does not match relay network');
  }
  if (!trimString(approval.network) || !trimString(approval.policy_id)) {
    throw new Error('stored sponsorship approval has incomplete network or policy identity');
  }
  if (!trimString(approval.account_id)) {
    throw new Error('stored sponsorship approval has no account_id');
  }
  if (
    !trimString(approval.target_contract) ||
    !trimString(approval.method) ||
    !OPERATION_HASH_PATTERN.test(trimString(approval.operation_hash))
  ) {
    throw new Error('stored sponsorship approval has incomplete operation metadata');
  }
  if (
    !Number.isSafeInteger(Number(approval.estimated_gas_units)) ||
    Number(approval.estimated_gas_units) < 1
  ) {
    throw new Error('stored sponsorship approval has invalid estimated_gas_units');
  }
  const expiresAtMs = Date.parse(approval.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error('sponsorship approval is expired or has an invalid expires_at');
  }
  const digest = trimString(approval.approval_digest).toLowerCase();
  if (
    !APPROVAL_DIGEST_PATTERN.test(digest) ||
    digest !== sponsorshipApprovalDigest(approval).toLowerCase()
  ) {
    throw new Error('sponsorship approval_digest is invalid');
  }
  return approval;
}

async function storageCall(operation) {
  try {
    return await operation();
  } catch (error) {
    const wrapped = new Error(`sponsorship approval storage failed: ${error?.message || error}`);
    wrapped.status = 503;
    throw wrapped;
  }
}

export async function persistSponsorshipApproval(approval) {
  assertSponsorshipApproval(approval, { network: approval?.network });
  const ttlMs = Date.parse(approval.expires_at) - Date.now();
  const stored = await storageCall(() =>
    upstashSetJsonOnceRequired(approvalKey(approval.sponsorship_id), approval, ttlMs)
  );
  if (!stored) {
    const error = new Error('sponsorship approval id already exists');
    error.status = 503;
    throw error;
  }
}

export async function readSponsorshipApproval(id, network) {
  const approval = await storageCall(() => upstashGetJsonRequired(approvalKey(id)));
  if (!approval) throw new Error('sponsorship approval is missing, expired, or already consumed');
  return assertSponsorshipApproval(approval, { id, network });
}

export async function consumeSponsorshipApproval(id, network, readApproval) {
  const consumed = await storageCall(() => upstashTakeJsonRequired(approvalKey(id)));
  if (!consumed) throw new Error('sponsorship approval is missing, expired, or already consumed');
  assertSponsorshipApproval(consumed, { id, network });
  if (stableStringify(consumed) !== stableStringify(readApproval)) {
    throw new Error('consumed sponsorship approval differs from the verified approval');
  }
  return consumed;
}

function containers(payload = {}) {
  const nested = [payload.approval, payload.paymaster, payload.sponsorship_approval].filter(
    (value) => value && typeof value === 'object' && !Array.isArray(value)
  );
  return [payload, ...nested];
}

function suppliedValue(container, names) {
  for (const name of names) {
    if (container[name] !== undefined && container[name] !== null && container[name] !== '') {
      return container[name];
    }
  }
  return undefined;
}

export function resolveSponsorshipId(payload = {}) {
  const values = containers(payload)
    .map((container) => suppliedValue(container, ['sponsorship_id', 'sponsorshipId']))
    .filter((value) => value !== undefined)
    .map((value) => sponsorshipId(value));
  if (!values.length) throw new Error('sponsorship_id is required for transaction sponsorship');
  if (values.some((value) => value !== values[0])) {
    throw new Error('conflicting sponsorship_id values were supplied');
  }
  return values[0];
}

const SUPPLIED_FIELDS = [
  { key: 'network', names: ['network'], normalize: (value) => trimString(value).toLowerCase() },
  {
    key: 'target_chain',
    names: ['target_chain', 'targetChain'],
    normalize: (value) => trimString(value).toLowerCase(),
  },
  { key: 'policy_id', names: ['policy_id', 'policyId'], normalize: trimString },
  {
    key: 'account_id',
    names: ['account_id', 'accountId'],
    normalize: (value) => trimString(value).toLowerCase(),
  },
  {
    key: 'dapp_id',
    names: ['dapp_id', 'dappId'],
    normalize: (value) => trimString(value).toLowerCase(),
  },
  {
    key: 'target_contract',
    names: ['target_contract', 'targetContract'],
    normalize: (value) => trimString(value).toLowerCase().replace(/^0x/, ''),
  },
  { key: 'method', names: ['method', 'target_method', 'targetMethod'], normalize: trimString },
  {
    key: 'userop_target_contract',
    names: ['userop_target_contract', 'userOpTargetContract'],
    normalize: (value) => trimString(value).toLowerCase().replace(/^0x/, ''),
  },
  {
    key: 'userop_method',
    names: ['userop_method', 'userOpMethod'],
    normalize: trimString,
  },
  {
    key: 'estimated_gas_units',
    names: ['estimated_gas_units', 'estimatedGasUnits'],
    normalize: Number,
  },
  {
    key: 'operation_hash',
    names: ['operation_hash', 'operationHash'],
    normalize: (value) => trimString(value).toLowerCase(),
  },
  {
    key: 'approval_digest',
    names: ['approval_digest', 'approvalDigest'],
    normalize: (value) => trimString(value).toLowerCase(),
  },
  { key: 'expires_at', names: ['expires_at', 'expiresAt'], normalize: trimString },
];

export function assertSuppliedSponsorshipFields(payload, approval) {
  for (const container of containers(payload)) {
    if (container.approved === false)
      throw new Error('a denied verdict cannot sponsor a transaction');
    for (const field of SUPPLIED_FIELDS) {
      const supplied = suppliedValue(container, field.names);
      if (supplied === undefined) continue;
      const actual = field.normalize(supplied);
      const expected = field.normalize(approval[field.key]);
      if (actual !== expected) {
        throw new Error(`${field.key} does not match the stored sponsorship approval`);
      }
    }
  }
}
