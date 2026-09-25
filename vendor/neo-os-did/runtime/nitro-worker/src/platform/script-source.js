import { rpc as neoRpc } from '@cityofzion/neon-js';
import { canonicalizeMethodName, normalizeContractHash, toNeoContractParam } from './allowlist.js';
import {
  decodeBase64,
  env,
  normalizeTargetChain,
  resolveMaxBytes,
  resolvePayloadNetwork,
  resolveTrustedRpcUrl,
  trimString,
} from './core.js';

function parseScriptStackItem(item, encoding = 'utf8') {
  if (!item || typeof item !== 'object') return '';
  const type = trimString(item.type).toLowerCase();
  if (type === 'string') {
    const text = String(item.value ?? '');
    return encoding === 'base64' ? decodeBase64(text).toString('utf8') : text;
  }
  if (type === 'bytestring' || type === 'bytearray') {
    const raw = trimString(item.value);
    const bytes = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
    if (encoding === 'base64') {
      return decodeBase64(bytes.toString('utf8')).toString('utf8');
    }
    return bytes.toString('utf8');
  }
  throw new Error(`script reference returned unsupported stack type: ${item.type}`);
}

async function normalizeScriptReference(payload = {}) {
  const explicit =
    payload.script_ref && typeof payload.script_ref === 'object' ? payload.script_ref : null;
  const contractHash = trimString(
    explicit?.contract_hash || payload.script_registry_contract || ''
  );
  if (!contractHash) return null;
  const method =
    trimString(explicit?.method || payload.script_registry_method || 'getScript') || 'getScript';
  const scriptName = trimString(explicit?.script_name || payload.script_name || '');
  const args = Array.isArray(explicit?.params)
    ? explicit.params
    : Array.isArray(payload.script_registry_args)
      ? payload.script_registry_args
      : scriptName
        ? [{ type: 'String', value: scriptName }]
        : [];
  const userRpcUrl = trimString(explicit?.rpc_url || payload.rpc_url || '');
  const network = resolvePayloadNetwork(payload, 'testnet');
  const resolvedRpcUrl = await resolveTrustedRpcUrl(network, userRpcUrl);
  return {
    target_chain: trimString(explicit?.target_chain || payload.target_chain || 'neo_n3'),
    rpc_url: resolvedRpcUrl,
    contract_hash: normalizeContractHash(contractHash),
    method: canonicalizeMethodName(method),
    params: args,
    encoding:
      trimString(explicit?.encoding || payload.script_registry_encoding || 'utf8').toLowerCase() ||
      'utf8',
  };
}

export async function resolveScriptSource(payload = {}) {
  if (typeof payload.script === 'string' && payload.script.trim()) return payload.script;
  if (typeof payload.script_base64 === 'string' && payload.script_base64.trim()) {
    return decodeBase64(payload.script_base64).toString('utf8');
  }

  const reference = await normalizeScriptReference(payload);
  if (!reference) return '';

  const targetChain = normalizeTargetChain(reference.target_chain);
  if (targetChain !== 'neo_n3') {
    throw new Error('script_ref currently supports neo_n3 only');
  }
  if (!reference.rpc_url) {
    throw new Error('NEO_RPC_URL is required for script_ref resolution');
  }

  const rpcClient = new neoRpc.RPCClient(reference.rpc_url);
  const params = Array.isArray(reference.params)
    ? reference.params.map((param) => toNeoContractParam(param).toJson())
    : [];
  const response = await rpcClient.invokeFunction(
    reference.contract_hash,
    reference.method,
    params
  );
  if (String(response.state || '').toUpperCase() === 'FAULT') {
    throw new Error(response.exception || `script_ref ${reference.method} faulted`);
  }
  const script = parseScriptStackItem(response.stack?.[0], reference.encoding);
  const maxBytes = resolveMaxBytes(env('MORPHEUS_MAX_REGISTERED_SCRIPT_BYTES'), 64 * 1024, 1024);
  if (Buffer.byteLength(script, 'utf8') > maxBytes) {
    throw new Error(`registered script exceeds max size of ${maxBytes} bytes`);
  }
  if (!trimString(script)) {
    throw new Error('script_ref resolved to an empty script');
  }
  return script;
}
