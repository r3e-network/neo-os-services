const MAINNET_MAGIC = 860833102;
const TESTNET_MAGIC = 894710606;

type DapiAccount = {
  hash?: string;
  address?: string;
  isDefault?: boolean;
};

type DapiProvider = {
  name?: string;
  network?: number;
  supportedNetworks?: number[];
  getAccounts?: () => Promise<DapiAccount[]>;
  authenticate?: (payload: {
    action: 'Authentication';
    grant_type: 'Signature';
    allowed_algorithms: ['ECDSA-P256'];
    domain: string;
    networks: number[];
    nonce: string;
    timestamp: number;
  }) => Promise<{ address?: string; network?: number; pubkey?: string }>;
  invoke?: (
    invocations: Array<{
      hash: string;
      operation: string;
      args?: Array<{ type: string; value: unknown }>;
      abortOnFail?: boolean;
    }>,
    signers?: Array<{ account: string; scopes: string }>
  ) => Promise<unknown>;
};

type DapiWindow = Window & {
  Neo?: { DapiProvider?: unknown };
  neoDapiProvider?: unknown;
  neoDapi?: unknown;
};

export type MorpheusOracleInvokeRequest = {
  oracleHash: string;
  requestType: string;
  payloadBase64: string;
  callbackHash: string;
  callbackMethod: string;
  expectedNetworkMagic?: number;
  expectedNetworkLabel?: string;
};

function isDapiProvider(value: unknown): value is DapiProvider {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Partial<DapiProvider>;
  return typeof provider.getAccounts === 'function' || typeof provider.authenticate === 'function';
}

function readImmediateProvider(): DapiProvider | null {
  if (typeof window === 'undefined') return null;
  const win = window as DapiWindow;
  const candidates = [win.Neo?.DapiProvider, win.neoDapiProvider, win.neoDapi];
  return candidates.find(isDapiProvider) ?? null;
}

function createNonce() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function getAuthenticationDomain() {
  if (typeof window === 'undefined') return 'localhost';
  return window.location.host || window.location.hostname || 'localhost';
}

function normalizeTxResult(result: unknown) {
  if (typeof result === 'string') return { txid: result };
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const txid = String(record.txid ?? record.tx ?? record.hash ?? '');
    return txid ? { ...record, txid } : record;
  }
  return {};
}

function stripHexPrefix(value: string) {
  return String(value || '')
    .trim()
    .replace(/^0x/i, '');
}

function assertHash160(value: string, label: string) {
  const normalized = stripHexPrefix(value);
  if (!/^[0-9a-f]{40}$/i.test(normalized)) {
    throw new Error(`${label} must be a 20-byte Hash160 value`);
  }
}

function assertBase64Payload(value: string) {
  const payload = String(value || '').trim();
  if (!payload) throw new Error('Oracle payload is empty');
  try {
    if (typeof atob === 'function') {
      atob(payload);
    } else {
      Buffer.from(payload, 'base64');
    }
  } catch {
    throw new Error('Oracle payload must be valid base64');
  }
}

function assertInvokeRequest(request: MorpheusOracleInvokeRequest) {
  if (!String(request.requestType || '').trim()) {
    throw new Error('Oracle request type is required');
  }
  assertBase64Payload(request.payloadBase64);
  assertHash160(request.oracleHash, 'Oracle contract hash');
  assertHash160(request.callbackHash, 'Callback contract hash');
  if (!String(request.callbackMethod || '').trim()) {
    throw new Error('Callback method is required');
  }
}

function assertExpectedNetwork(
  provider: DapiProvider,
  expectedNetworkMagic?: number,
  expectedNetworkLabel = 'selected Neo N3 network'
) {
  if (!expectedNetworkMagic) return;
  if (provider.network === expectedNetworkMagic) return;
  if (typeof provider.network === 'number') {
    throw new Error(
      `NEP-21 wallet is connected to network magic ${provider.network}, but this page targets ${expectedNetworkLabel} (${expectedNetworkMagic}). Switch wallet network before submitting.`
    );
  }
  if (
    provider.supportedNetworks?.length &&
    !provider.supportedNetworks.includes(expectedNetworkMagic)
  ) {
    throw new Error(
      `NEP-21 wallet does not advertise ${expectedNetworkLabel} (${expectedNetworkMagic}). Switch to a compatible Neo N3 wallet/network before submitting.`
    );
  }
  throw new Error(
    `NEP-21 wallet network could not be verified. Switch wallet to ${expectedNetworkLabel} (${expectedNetworkMagic}) and reconnect before submitting.`
  );
}

function assertAuthenticatedNetwork(
  authenticatedNetwork: number | undefined,
  expectedNetworkMagic?: number,
  expectedNetworkLabel = 'selected Neo N3 network'
) {
  if (!expectedNetworkMagic || authenticatedNetwork === undefined) return;
  if (authenticatedNetwork === expectedNetworkMagic) return;
  throw new Error(
    `NEP-21 wallet authenticated on network magic ${authenticatedNetwork}, but this page targets ${expectedNetworkLabel} (${expectedNetworkMagic}). Switch wallet network before submitting.`
  );
}

function resolveVerifiedNetwork(provider: DapiProvider, authenticatedNetwork?: number) {
  if (typeof provider.network === 'number') return provider.network;
  if (typeof authenticatedNetwork === 'number') return authenticatedNetwork;
  if (provider.supportedNetworks?.length === 1) return provider.supportedNetworks[0];
  return undefined;
}

export function requestNeoDapiProvider(timeoutMs = 3000): Promise<DapiProvider> {
  const immediate = readImmediateProvider();
  if (immediate) return Promise.resolve(immediate);
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('NEP-21 dAPI requires a browser context'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (provider: DapiProvider) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener('Neo.DapiProvider.ready', onReady);
      resolve(provider);
    };
    const onReady = (event: Event) => {
      const provider = (event as CustomEvent<{ provider?: unknown }>).detail?.provider;
      if (!isDapiProvider(provider)) return;
      finish(provider);
    };
    window.addEventListener('Neo.DapiProvider.ready', onReady);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('Neo.DapiProvider.ready', onReady);
      reject(new Error('NEP-21 dAPI wallet not detected'));
    }, timeoutMs);
    window.dispatchEvent(
      new CustomEvent('Neo.DapiProvider.request', {
        detail: { version: '1.0' },
      })
    );
  });
}

async function resolveAccount(provider: DapiProvider, request: MorpheusOracleInvokeRequest) {
  const accounts = (await provider.getAccounts?.().catch(() => [])) ?? [];
  const account = accounts.find((entry) => entry.isDefault) ?? accounts[0];
  if (account?.hash || account?.address) {
    return {
      address: account.address ?? account.hash ?? '',
      accountHash: account.hash,
      authenticatedNetwork: undefined,
    };
  }

  if (!provider.authenticate) {
    throw new Error('NEP-21 wallet did not return an account');
  }

  const authenticated = await provider.authenticate({
    action: 'Authentication',
    grant_type: 'Signature',
    allowed_algorithms: ['ECDSA-P256'],
    domain: getAuthenticationDomain(),
    networks: provider.supportedNetworks?.length
      ? provider.supportedNetworks
      : [TESTNET_MAGIC, MAINNET_MAGIC],
    nonce: createNonce(),
    timestamp: Date.now(),
  });
  assertAuthenticatedNetwork(
    authenticated.network,
    request.expectedNetworkMagic,
    request.expectedNetworkLabel
  );

  const address = String(authenticated.address ?? '').trim();
  if (!address) throw new Error('NEP-21 wallet authentication did not return an address');
  const refreshedAccounts = (await provider.getAccounts?.().catch(() => [])) ?? [];
  const refreshedAccount =
    refreshedAccounts.find((entry) => entry.address === address) ?? refreshedAccounts[0];
  return {
    address,
    accountHash: refreshedAccount?.hash,
    authenticatedNetwork: authenticated.network,
  };
}

export async function invokeMorpheusOracleRequest(request: MorpheusOracleInvokeRequest) {
  assertInvokeRequest(request);
  const provider = await requestNeoDapiProvider();
  if (!provider.invoke) throw new Error('NEP-21 wallet does not support invoke');
  const account = await resolveAccount(provider, request);
  assertExpectedNetwork(
    {
      ...provider,
      network: resolveVerifiedNetwork(provider, account.authenticatedNetwork),
    },
    request.expectedNetworkMagic,
    request.expectedNetworkLabel
  );
  const signers = account.accountHash
    ? [{ account: account.accountHash, scopes: 'CalledByEntry' }]
    : undefined;

  const result = await provider.invoke(
    [
      {
        hash: request.oracleHash,
        operation: 'request',
        abortOnFail: true,
        args: [
          { type: 'String', value: request.requestType },
          { type: 'ByteArray', value: request.payloadBase64 },
          { type: 'Hash160', value: request.callbackHash },
          { type: 'String', value: request.callbackMethod },
        ],
      },
    ],
    signers
  );

  return normalizeTxResult(result);
}
