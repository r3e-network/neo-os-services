import { sc, u, wallet as neoWallet } from '@cityofzion/neon-js';
import { envForNetwork, isHexString, strip0x, trimString, resolvePayloadNetwork } from './core.js';

export function normalizeNeoHash160(value) {
  const raw = trimString(value);
  if (!raw) return '';
  if (neoWallet.isAddress(raw)) {
    return `0x${neoWallet.getScriptHashFromAddress(raw).toLowerCase()}`;
  }
  const hex = strip0x(raw).toLowerCase();
  if (/^[0-9a-f]{40}$/.test(hex)) return `0x${hex}`;
  return '';
}

export function isConfiguredHash160(value) {
  return /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
}

export function normalizeContractHash(value) {
  const normalized = normalizeNeoHash160(value);
  if (!normalized) throw new Error(`invalid contract hash: ${value}`);
  return normalized;
}

export function canonicalizeMethodName(method) {
  const trimmed = trimString(method);
  if (!trimmed) return '';
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

export function createByteArrayParam(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return sc.ContractParam.byteArray(
      u.HexString.fromHex(Buffer.from(value).toString('hex'), true)
    );
  }
  const raw = trimString(value);
  if (!raw) return sc.ContractParam.byteArray(u.HexString.fromHex(''));
  if (isHexString(raw)) {
    return sc.ContractParam.byteArray(u.HexString.fromHex(strip0x(raw), true));
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) {
    try {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length > 0 && decoded.toString('base64') === raw) {
        return sc.ContractParam.byteArray(u.HexString.fromHex(decoded.toString('hex'), true));
      }
    } catch {
      // fall through to utf-8 string byte array handling
    }
  }
  return sc.ContractParam.byteArray(raw);
}

export function toNeoContractParam(param) {
  if (!param || typeof param !== 'object') throw new Error('invalid Neo contract param');
  const type = trimString(param.type).toLowerCase();
  switch (type) {
    case 'string':
      return sc.ContractParam.string(String(param.value ?? ''));
    case 'integer':
      return sc.ContractParam.integer(String(param.value ?? '0'));
    case 'boolean':
      return sc.ContractParam.boolean(Boolean(param.value));
    case 'bytearray':
      return createByteArrayParam(param.value);
    case 'hash160':
      return sc.ContractParam.hash160(String(param.value ?? ''));
    case 'hash256':
      return sc.ContractParam.hash256(String(param.value ?? ''));
    case 'publickey':
      return sc.ContractParam.publicKey(String(param.value ?? ''));
    case 'any':
      return sc.ContractParam.any(param.value ?? null);
    case 'array': {
      if (!Array.isArray(param.value)) throw new Error('Array param requires array value');
      return sc.ContractParam.array(
        ...param.value.map((item) => toNeoContractParam(item).toJson())
      );
    }
    default:
      throw new Error(`unsupported Neo contract param type: ${param.type}`);
  }
}

export function parseTxProxyAllowlist(raw) {
  const out = new Map();
  const text = trimString(raw);
  if (!text) return out;
  const parsed = JSON.parse(text);
  const contracts = parsed && typeof parsed === 'object' ? parsed.contracts : null;
  if (!contracts || typeof contracts !== 'object') return out;
  for (const [contract, methods] of Object.entries(contracts)) {
    const normalized = normalizeNeoHash160(contract);
    if (!normalized) continue;
    const entry = { allowAll: false, methods: new Set() };
    if (Array.isArray(methods)) {
      for (const method of methods) {
        const canonical = trimString(method);
        if (!canonical) continue;
        if (canonical === '*') {
          entry.allowAll = true;
          continue;
        }
        entry.methods.add(canonicalizeMethodName(canonical));
      }
    }
    out.set(normalized, entry);
  }
  return out;
}

export function addAllow(allowlist, contractHash, ...methods) {
  const normalized = normalizeNeoHash160(contractHash);
  if (!normalized || !isConfiguredHash160(normalized)) return;
  const current = allowlist.get(normalized) || { allowAll: false, methods: new Set() };
  for (const method of methods) {
    const canonical = trimString(method);
    if (!canonical) continue;
    if (canonical === '*') {
      current.allowAll = true;
      continue;
    }
    current.methods.add(canonicalizeMethodName(canonical));
  }
  allowlist.set(normalized, current);
}

const allowlistCache = new Map();

function resolveAllowlistNetwork(input) {
  if (typeof input === 'string') {
    return input.trim().toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
  }
  return resolvePayloadNetwork(input || {}, 'testnet');
}

export function buildTxProxyAllowlist(networkInput = 'testnet') {
  const network = resolveAllowlistNetwork(networkInput);
  const now = Date.now();
  const cached = allowlistCache.get(network);
  if (cached && now - cached.timestamp < 60_000) return cached.result;

  const allowlist = parseTxProxyAllowlist(envForNetwork(network, 'TXPROXY_ALLOWLIST'));
  addAllow(
    allowlist,
    envForNetwork(network, 'CONTRACT_MORPHEUS_DATAFEED_HASH', 'CONTRACT_PRICEFEED_HASH'),
    'updateFeed',
    'updateFeedSigned',
    'updateFeeds',
    'update'
  );
  addAllow(allowlist, envForNetwork(network, 'CONTRACT_RANDOMNESSLOG_HASH'), 'record');
  addAllow(allowlist, envForNetwork(network, 'CONTRACT_AUTOMATIONANCHOR_HASH'), 'markExecuted');
  addAllow(
    allowlist,
    envForNetwork(network, 'CONTRACT_MORPHEUS_ORACLE_HASH'),
    'fulfillRequest',
    'queueAutomationRequest'
  );
  addAllow(allowlist, envForNetwork(network, 'CONTRACT_PAYMENTHUB_HASH'), 'pay');
  addAllow(
    allowlist,
    envForNetwork(network, 'CONTRACT_GOVERNANCE_HASH'),
    'stake',
    'unstake',
    'vote'
  );
  addAllow(
    allowlist,
    envForNetwork(network, 'CONTRACT_GAS_HASH') || '0xd2a4cff31913016155e38e474a2c06d08be276cf',
    'transfer'
  );
  allowlistCache.set(network, { timestamp: now, result: allowlist });
  return allowlist;
}

export function allowlistAllows(contractHash, method, networkInput = 'testnet') {
  const allowlist = buildTxProxyAllowlist(networkInput);
  const entry = allowlist.get(normalizeContractHash(contractHash));
  if (!entry) return false;
  if (entry.allowAll) return true;
  return entry.methods.has(canonicalizeMethodName(method));
}

export function transferTargetsPaymentHub(params, paymentHubHash) {
  if (!Array.isArray(params) || params.length < 2) return false;
  const target = params[1];
  if (!target || trimString(target.type).toLowerCase() !== 'hash160') return false;
  return normalizeNeoHash160(target.value) === normalizeNeoHash160(paymentHubHash);
}

export function checkNeoIntentPolicy(payload) {
  const intent = trimString(payload.intent).toLowerCase();
  if (!intent) return null;

  const network = resolveAllowlistNetwork(payload);
  const contractHash = normalizeContractHash(payload.contract_hash);
  const method = canonicalizeMethodName(payload.method);
  const gasHash = normalizeNeoHash160(
    envForNetwork(network, 'CONTRACT_GAS_HASH') || '0xd2a4cff31913016155e38e474a2c06d08be276cf'
  );
  const paymentHubHash = normalizeNeoHash160(envForNetwork(network, 'CONTRACT_PAYMENTHUB_HASH'));
  const governanceHash = normalizeNeoHash160(envForNetwork(network, 'CONTRACT_GOVERNANCE_HASH'));

  switch (intent) {
    case 'gas-sponsor':
    case 'gas_sponsor':
      if (contractHash !== gasHash || method !== 'transfer')
        return { status: 403, error: 'gas-sponsor intent only allows GAS transfer' };
      return null;
    case 'payments':
    case 'payment':
      if (contractHash !== gasHash || method !== 'transfer')
        return { status: 403, error: 'payments intent only allows GAS transfer' };
      if (!paymentHubHash)
        return { status: 503, error: 'payments intent requires CONTRACT_PAYMENTHUB_HASH' };
      if (!transferTargetsPaymentHub(payload.params, paymentHubHash))
        return { status: 403, error: 'payments intent only allows GAS transfer to PaymentHub' };
      return null;
    case 'governance':
      if (!governanceHash)
        return { status: 503, error: 'governance intent requires CONTRACT_GOVERNANCE_HASH' };
      if (contractHash !== governanceHash)
        return { status: 403, error: 'governance intent requires Governance contract' };
      if (!['stake', 'unstake', 'vote'].includes(method))
        return { status: 403, error: 'governance intent only allows stake/unstake/vote' };
      return null;
    default:
      return { status: 400, error: `unknown intent: ${payload.intent}` };
  }
}
