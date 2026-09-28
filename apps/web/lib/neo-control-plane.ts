import {
  AUTOMATION_EXECUTION_QUEUE_METHOD,
  kernelManifestSupportsAutomationExecution,
  normalizeAutomationRegistrationRequestId,
  selectAutomationQueueLane,
} from '@r3e-network/neo-os-services-shared/automation-supervisor';
import { getServerSupabaseClient, type MorpheusNetwork } from './server-supabase';
import { appConfig } from './config';
import { isRetryableStatus } from './nitro';
import { networkRegistry } from './networks';
import { trimString } from './strings';

function pickValue(...values: unknown[]) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function resolveNeoN3Runtime(network: MorpheusNetwork) {
  const cfg = networkRegistry[network];
  const reviewedMagic = Number(cfg.neo_n3?.network_magic || 0);
  if (!Number.isSafeInteger(reviewedMagic) || reviewedMagic <= 0) {
    throw new Error(`reviewed Neo N3 network magic is missing for ${network}`);
  }
  const configuredMagic = pickValue(
    network === 'mainnet'
      ? process.env.NEO_MAINNET_NETWORK_MAGIC
      : process.env.NEO_TESTNET_NETWORK_MAGIC,
    process.env.NEO_NETWORK_MAGIC
  );
  if (configuredMagic && Number(configuredMagic) !== reviewedMagic) {
    throw new Error(`configured Neo N3 network magic conflicts with reviewed ${network} identity`);
  }
  return {
    rpcUrl: pickValue(
      network === 'mainnet' ? process.env.NEO_MAINNET_RPC_URL : process.env.NEO_TESTNET_RPC_URL,
      process.env.NEO_RPC_URL,
      cfg.neo_n3?.rpc_url
    ),
    networkMagic: reviewedMagic,
    oracleHash: pickValue(
      network === 'mainnet'
        ? process.env.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET
        : process.env.CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET,
      process.env.CONTRACT_MORPHEUS_ORACLE_HASH,
      cfg.neo_n3?.contracts?.morpheus_oracle
    ),
  };
}

type WorkerRelayResult = {
  request_id?: string;
  tx_hash?: string;
  vm_state?: string | null;
  exception?: string | null;
  error?: string;
};

// Operator intent on the oracle contract (fulfillRequest /
// queueAutomationRequest) is relayed through the Nitro worker's custody-signed
// txproxy lane: the worker builds, fee-estimates and custody-signs the
// invocation as the updater account. No signer material ever leaves this
// process, so the web tier holds no Neo N3 key.
async function relayNeoN3InvocationViaWorker(
  network: MorpheusNetwork,
  payload: {
    request_id: string;
    method: string;
    params: { type: string; value: unknown }[];
    wait: boolean;
  }
): Promise<WorkerRelayResult> {
  const runtime = resolveNeoN3Runtime(network);
  if (!runtime.rpcUrl || !runtime.oracleHash) {
    throw new Error(`Neo N3 runtime is not configured for ${network}`);
  }

  const configuredCandidateUrls =
    Array.isArray(appConfig.nitroApiUrls) && appConfig.nitroApiUrls.length > 0
      ? appConfig.nitroApiUrls
      : appConfig.nitroApiUrl
        ? [appConfig.nitroApiUrl]
        : [];
  // The txproxy request causes a custody signature and an on-chain mutation.
  // Production must never retry it against a second runtime host.
  const candidateUrls =
    process.env.NODE_ENV === 'production'
      ? configuredCandidateUrls.slice(0, 1)
      : configuredCandidateUrls;
  if (candidateUrls.length === 0) {
    throw new Error('MORPHEUS_RUNTIME_URL is not configured');
  }

  const headers = new Headers({ 'content-type': 'application/json' });
  if (appConfig.nitroToken) {
    headers.set('authorization', `Bearer ${appConfig.nitroToken}`);
    headers.set('x-nitro-token', appConfig.nitroToken);
  }

  const body = JSON.stringify({
    target_chain: 'neo_n3',
    network,
    contract_hash: runtime.oracleHash,
    method: payload.method,
    params: payload.params,
    request_id: payload.request_id,
    wait: payload.wait,
  });

  let lastStatus = 503;
  let lastBody: WorkerRelayResult = {};
  for (const apiBaseUrl of candidateUrls) {
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/txproxy/invoke`, {
        method: 'POST',
        headers,
        body,
        cache: 'no-store',
        // Long enough to cover the worker's wait-for-application-log window.
        signal: AbortSignal.timeout(20000),
      });
      const text = await response.text();
      let parsed: unknown = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {}
      lastStatus = response.status;
      lastBody = isPlainObject(parsed) ? (parsed as WorkerRelayResult) : {};
      if (response.ok || !isRetryableStatus(response.status)) {
        break;
      }
    } catch (error) {
      lastStatus = 503;
      lastBody = { error: error instanceof Error ? error.message : 'fetch failed' };
    }
  }

  if (lastStatus < 200 || lastStatus >= 300) {
    throw new Error(trimString(lastBody.error) || `worker relay failed (${lastStatus})`);
  }
  if (!trimString(lastBody.tx_hash)) {
    throw new Error('worker relay returned no transaction hash');
  }
  return lastBody;
}

export async function fulfillNeoN3RequestViaBackend(input: {
  network: MorpheusNetwork;
  requestId: string;
  success: boolean;
  result: string;
  error: string;
  verificationSignature: string;
  resultBytesBase64?: string;
}) {
  const resultHex = trimString(input.resultBytesBase64)
    ? Buffer.from(trimString(input.resultBytesBase64), 'base64').toString('hex')
    : Buffer.from(String(input.result || ''), 'utf8').toString('hex');
  const verificationSigHex = trimString(input.verificationSignature).replace(/^0x/i, '');

  const relayed = await relayNeoN3InvocationViaWorker(input.network, {
    request_id: `web-fulfill-${input.requestId}`,
    method: 'fulfillRequest',
    params: [
      { type: 'integer', value: String(input.requestId) },
      { type: 'boolean', value: Boolean(input.success) },
      { type: 'bytearray', value: resultHex },
      { type: 'string', value: input.error || '' },
      { type: 'bytearray', value: verificationSigHex },
    ],
    wait: true,
  });

  return {
    tx_hash: String(relayed.tx_hash),
    vm_state: relayed.vm_state ?? null,
    exception: relayed.exception ?? null,
    target_chain: 'neo_n3' as const,
  };
}

// Reads the deployed kernel ABI (getcontractstate) to learn whether it has the R-01
// execution lane. Fails closed: a transport, RPC or ABI error throws, so the dispatch fails
// and is retried rather than guessing a lane (the legacy lane on an upgraded kernel cannot
// charge a requester the app fee payer does not sponsor).
async function kernelSupportsAutomationExecution(network: MorpheusNetwork): Promise<boolean> {
  const runtime = resolveNeoN3Runtime(network);
  if (!runtime.rpcUrl || !runtime.oracleHash) {
    throw new Error(`Neo N3 runtime is not configured for ${network}`);
  }
  const response = await fetch(runtime.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getcontractstate',
      params: [runtime.oracleHash],
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isPlainObject(body) || body.error !== undefined) {
    throw new Error(`Neo N3 getcontractstate failed for the oracle kernel (${response.status})`);
  }
  const result = isPlainObject(body.result) ? body.result : {};
  return kernelManifestSupportsAutomationExecution(result.manifest);
}

export async function queueNeoN3AutomationViaBackend(input: {
  network: MorpheusNetwork;
  requester: string;
  requestType: string;
  payloadText: string;
  callbackContract: string;
  callbackMethod: string;
  requestId: string;
  // The kernel request id of the job's automation_register request. With a kernel that
  // has the R-01 execution lane, the execution is tied to that registration so the job
  // owner's spend approval (not a bare requester name) is what can pay for it.
  registrationRequestId?: string;
}) {
  const registrationRequestId = normalizeAutomationRegistrationRequestId(
    input.registrationRequestId
  );
  const lane = selectAutomationQueueLane({
    supportsExecutionLane: registrationRequestId
      ? await kernelSupportsAutomationExecution(input.network)
      : false,
    registrationRequestId,
  });
  const payloadHex = Buffer.from(input.payloadText, 'utf8').toString('hex');
  const params =
    lane.method === AUTOMATION_EXECUTION_QUEUE_METHOD
      ? [
          { type: 'integer', value: lane.registrationRequestId },
          { type: 'hash160', value: input.requester },
          { type: 'string', value: input.requestType },
          { type: 'bytearray', value: payloadHex },
        ]
      : [
          { type: 'hash160', value: input.requester },
          { type: 'string', value: input.requestType },
          { type: 'bytearray', value: payloadHex },
          { type: 'hash160', value: input.callbackContract },
          { type: 'string', value: input.callbackMethod },
        ];
  const relayed = await relayNeoN3InvocationViaWorker(input.network, {
    request_id: `web-queue-${input.requestId}`,
    method: lane.method,
    params,
    wait: false,
  });

  return {
    tx_hash: String(relayed.tx_hash),
    request_id: input.requestId,
    target_chain: 'neo_n3' as const,
    queue_method: lane.method,
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
