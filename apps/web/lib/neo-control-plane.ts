import { experimental, rpc as neoRpc, sc, u, wallet as neoWallet } from '@cityofzion/neon-js';
import {
  getServerSupabaseClient,
  resolveSupabaseNetwork,
  type MorpheusNetwork,
} from './server-supabase';
import { networkRegistry } from './networks';
import { trimString } from './strings';

function pickValue(...values: unknown[]) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

export function resolveControlPlaneNetwork(value?: string | null): MorpheusNetwork {
  return resolveSupabaseNetwork(value);
}

export function resolveNeoN3Runtime(network: MorpheusNetwork) {
  const cfg = networkRegistry[network];
  return {
    rpcUrl: pickValue(
      network === 'mainnet' ? process.env.NEO_MAINNET_RPC_URL : process.env.NEO_TESTNET_RPC_URL,
      process.env.NEO_RPC_URL,
      cfg.neo_n3?.rpc_url
    ),
    networkMagic: Number(
      pickValue(
        network === 'mainnet'
          ? process.env.NEO_MAINNET_NETWORK_MAGIC
          : process.env.NEO_TESTNET_NETWORK_MAGIC,
        process.env.NEO_NETWORK_MAGIC,
        String(cfg.neo_n3?.network_magic || '')
      ) || (network === 'mainnet' ? '860833102' : '894710606')
    ),
    oracleHash: pickValue(
      network === 'mainnet'
        ? process.env.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET
        : process.env.CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET,
      process.env.CONTRACT_MORPHEUS_ORACLE_HASH,
      cfg.neo_n3?.contracts?.morpheus_oracle
    ),
  };
}

export function resolveNeoN3UpdaterSigner(network: MorpheusNetwork) {
  const scope = network === 'mainnet' ? 'MAINNET' : 'TESTNET';
  const wif = pickValue(
    process.env[`MORPHEUS_UPDATER_NEO_N3_WIF_${scope}` as keyof NodeJS.ProcessEnv],
    process.env[`MORPHEUS_RELAYER_NEO_N3_WIF_${scope}` as keyof NodeJS.ProcessEnv],
    process.env.MORPHEUS_UPDATER_NEO_N3_WIF,
    process.env.MORPHEUS_RELAYER_NEO_N3_WIF
  );
  const privateKey = pickValue(
    process.env[`MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_${scope}` as keyof NodeJS.ProcessEnv],
    process.env[`MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_${scope}` as keyof NodeJS.ProcessEnv],
    process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY,
    process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY
  );
  return {
    wif,
    privateKey,
  };
}

function resolveInputSignerMaterial(input?: {
  wif?: string | null;
  private_key?: string | null;
  privateKey?: string | null;
}) {
  return {
    wif: pickValue(input?.wif),
    privateKey: pickValue(input?.privateKey, input?.private_key),
  };
}

function createNeoN3Account(
  network: MorpheusNetwork,
  inputSigner?: {
    wif?: string | null;
    private_key?: string | null;
    privateKey?: string | null;
  }
) {
  const signer = {
    ...resolveNeoN3UpdaterSigner(network),
    ...resolveInputSignerMaterial(inputSigner),
  };
  const key = signer.wif || signer.privateKey;
  if (!key) {
    throw new Error(`Neo N3 updater signer is not configured for ${network}`);
  }
  return new neoWallet.Account(key);
}

export async function fulfillNeoN3RequestViaBackend(input: {
  network: MorpheusNetwork;
  requestId: string;
  success: boolean;
  result: string;
  error: string;
  verificationSignature: string;
  resultBytesBase64?: string;
  wif?: string;
  private_key?: string;
}) {
  const runtime = resolveNeoN3Runtime(input.network);
  if (!runtime.rpcUrl || !runtime.oracleHash) {
    throw new Error(`Neo N3 runtime is not configured for ${input.network}`);
  }
  const account = createNeoN3Account(input.network, input);
  const contract = new experimental.SmartContract(u.HexString.fromHex(runtime.oracleHash), {
    rpcAddress: runtime.rpcUrl,
    networkMagic: runtime.networkMagic,
    account,
  });
  const resultHex = trimString(input.resultBytesBase64)
    ? Buffer.from(trimString(input.resultBytesBase64), 'base64').toString('hex')
    : Buffer.from(String(input.result || ''), 'utf8').toString('hex');
  const txHashRaw = await contract.invoke('fulfillRequest', [
    sc.ContractParam.integer(String(input.requestId)),
    sc.ContractParam.boolean(Boolean(input.success)),
    sc.ContractParam.byteArray(u.HexString.fromHex(resultHex as never, true)),
    sc.ContractParam.string(input.error || ''),
    sc.ContractParam.byteArray(
      u.HexString.fromHex(
        trimString(input.verificationSignature).replace(/^0x/i, '') as never,
        true
      )
    ),
  ]);
  const txHash = trimString(txHashRaw).startsWith('0x')
    ? trimString(txHashRaw)
    : `0x${trimString(txHashRaw)}`;
  const rpcClient = new neoRpc.RPCClient(runtime.rpcUrl);
  const appLog = await rpcClient.getApplicationLog(txHash).catch(() => null);
  const execution = appLog?.executions?.[0];
  return {
    tx_hash: txHash,
    vm_state: execution?.vmstate || null,
    exception: execution?.exception || null,
    target_chain: 'neo_n3',
  };
}

export async function queueNeoN3AutomationViaBackend(input: {
  network: MorpheusNetwork;
  requester: string;
  requestType: string;
  payloadText: string;
  callbackContract: string;
  callbackMethod: string;
  requestId: string;
  wif?: string;
  private_key?: string;
}) {
  const runtime = resolveNeoN3Runtime(input.network);
  if (!runtime.rpcUrl || !runtime.oracleHash) {
    throw new Error(`Neo N3 runtime is not configured for ${input.network}`);
  }
  const account = createNeoN3Account(input.network, input);
  const contract = new experimental.SmartContract(u.HexString.fromHex(runtime.oracleHash), {
    rpcAddress: runtime.rpcUrl,
    networkMagic: runtime.networkMagic,
    account,
  });
  const txHashRaw = await contract.invoke('queueAutomationRequest', [
    sc.ContractParam.hash160(input.requester),
    sc.ContractParam.string(input.requestType),
    sc.ContractParam.byteArray(Buffer.from(input.payloadText, 'utf8').toString('base64') as never),
    sc.ContractParam.hash160(input.callbackContract),
    sc.ContractParam.string(input.callbackMethod),
  ]);
  const txHash = trimString(txHashRaw).startsWith('0x')
    ? trimString(txHashRaw)
    : `0x${trimString(txHashRaw)}`;
  return {
    tx_hash: txHash,
    request_id: input.requestId,
    target_chain: 'neo_n3',
  };
}

export async function fetchAutomationJobForBackend(network: MorpheusNetwork, automationId: string) {
  const supabase = getServerSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  const { data, error } = await supabase
    .from('morpheus_automation_jobs')
    .select('*')
    .eq('network', network)
    .eq('automation_id', automationId)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown> | null) ?? null;
}

export async function recordAutomationRunForBackend(
  network: MorpheusNetwork,
  record: Record<string, unknown>
) {
  const supabase = getServerSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  const automationRuns = supabase.from('morpheus_automation_runs') as any;
  const { error } = await automationRuns.insert({
    network,
    ...record,
  });
  if (error) throw error;
}

export async function patchAutomationJobForBackend(
  network: MorpheusNetwork,
  automationId: string,
  fields: Record<string, unknown>
) {
  const supabase = getServerSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  const { error } = await supabase
    .from('morpheus_automation_jobs')
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq('network', network)
    .eq('automation_id', automationId);
  if (error) throw error;
}
