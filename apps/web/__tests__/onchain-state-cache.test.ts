import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fetchNeoN3State fans out 7 RPC reads per uncached fetchOnchainState call.
const RPC_READS_PER_FETCH = 7;

const selectedNetwork = {
  network: 'testnet',
  neo_n3: {
    rpc_url: 'https://rpc.test.example',
    contracts: {
      morpheus_oracle: '0xoracle',
      morpheus_datafeed: '0xdatafeed',
    },
    domains: {},
  },
};

const getSelectedNetwork = vi.fn(() => selectedNetwork);
const getSelectedNetworkKey = vi.fn((override?: string | null) => override || 'testnet');

vi.mock('@/lib/networks', () => ({ getSelectedNetwork, getSelectedNetworkKey }));

function stubSuccessfulRpc() {
  // Every invokefunction returns a HALT state with an empty stack item so the
  // read resolves without faulting; the records read parses an empty array.
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ result: { state: 'HALT', stack: [{ type: 'Array', value: [] }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('onchain state cache', () => {
  beforeEach(async () => {
    vi.resetModules();
    getSelectedNetwork.mockClear();
    getSelectedNetworkKey.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves a repeat (network, limit) read from the short server-side cache', async () => {
    const fetchMock = stubSuccessfulRpc();
    const { fetchOnchainState, resetOnchainStateCache } = await import('@/lib/onchain-state');
    resetOnchainStateCache();

    const first = await fetchOnchainState(12);
    const second = await fetchOnchainState(12);

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(RPC_READS_PER_FETCH);
  });

  it('keys the cache on both network and limit', async () => {
    const fetchMock = stubSuccessfulRpc();
    const { fetchOnchainState, resetOnchainStateCache } = await import('@/lib/onchain-state');
    resetOnchainStateCache();

    await fetchOnchainState(12, 'testnet');
    await fetchOnchainState(24, 'testnet'); // different limit -> miss
    await fetchOnchainState(12, 'mainnet'); // different network -> miss
    await fetchOnchainState(12, 'testnet'); // repeat -> hit

    expect(fetchMock).toHaveBeenCalledTimes(RPC_READS_PER_FETCH * 3);
  });

  it('forces a fresh chain read after resetOnchainStateCache()', async () => {
    const fetchMock = stubSuccessfulRpc();
    const { fetchOnchainState, resetOnchainStateCache } = await import('@/lib/onchain-state');
    resetOnchainStateCache();

    await fetchOnchainState(12);
    resetOnchainStateCache();
    await fetchOnchainState(12);

    expect(fetchMock).toHaveBeenCalledTimes(RPC_READS_PER_FETCH * 2);
  });
});
