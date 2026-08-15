import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeMorpheusOracleRequest, requestNeoDapiProvider } from './nep21';

class TestCustomEvent<T> extends Event {
  detail: T;

  constructor(type: string, init?: { detail?: T }) {
    super(type);
    this.detail = init?.detail as T;
  }
}

function installWindow() {
  const target = new EventTarget() as EventTarget & {
    location: { host: string; hostname: string };
    Neo?: { DapiProvider?: unknown };
  };
  target.location = { host: 'morpheus.test', hostname: 'morpheus.test' };
  vi.stubGlobal('CustomEvent', TestCustomEvent);
  vi.stubGlobal('window', target);
  return target;
}

describe('Morpheus NEP-21 wallet helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches the standard provider request event and resolves the ready provider', async () => {
    const target = installWindow();
    const provider = { getAccounts: vi.fn(async () => []) };
    const requestedVersions: string[] = [];

    target.addEventListener('Neo.DapiProvider.request', (event) => {
      requestedVersions.push((event as CustomEvent<{ version?: string }>).detail?.version ?? '');
    });

    const pending = requestNeoDapiProvider(250);
    await Promise.resolve();

    expect(requestedVersions).toEqual(['1.0']);

    target.dispatchEvent(
      new CustomEvent('Neo.DapiProvider.ready', {
        detail: { provider },
      })
    );

    await expect(pending).resolves.toBe(provider);
  });

  it('submits oracle requests with NEP-21 invoke after NEP-21 authentication on the expected network', async () => {
    const target = installWindow();
    const provider = {
      supportedNetworks: [894710606],
      getAccounts: vi.fn(async () => []),
      authenticate: vi.fn(async () => ({
        address: 'NUserAddress',
        network: 894710606,
        pubkey: '03pub',
      })),
      invoke: vi.fn(async () => ({ txid: '0xoracletx' })),
    };
    target.Neo = { DapiProvider: provider };

    await expect(
      invokeMorpheusOracleRequest({
        oracleHash: `0x${'11'.repeat(20)}`,
        requestType: 'privacy_oracle',
        payloadBase64: 'eyJ4IjoxfQ==',
        callbackHash: `0x${'22'.repeat(20)}`,
        callbackMethod: 'onOracleResult',
        expectedNetworkMagic: 894710606,
        expectedNetworkLabel: 'Neo N3 Testnet',
      })
    ).resolves.toEqual({ txid: '0xoracletx' });

    expect(provider.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Authentication',
        grant_type: 'Signature',
        allowed_algorithms: ['ECDSA-P256'],
        domain: 'morpheus.test',
        networks: [894710606],
      })
    );
    expect(provider.invoke).toHaveBeenCalledWith(
      [
        {
          hash: `0x${'11'.repeat(20)}`,
          operation: 'request',
          abortOnFail: true,
          args: [
            { type: 'String', value: 'privacy_oracle' },
            { type: 'ByteArray', value: 'eyJ4IjoxfQ==' },
            { type: 'Hash160', value: `0x${'22'.repeat(20)}` },
            { type: 'String', value: 'onOracleResult' },
          ],
        },
      ],
      undefined
    );
  });

  it('rejects wallet submissions when the wallet is on the wrong Neo network', async () => {
    const target = installWindow();
    const provider = {
      network: 860833102,
      getAccounts: vi.fn(async () => [
        { hash: '0xuserhash', address: 'NUserAddress', isDefault: true },
      ]),
      invoke: vi.fn(async () => ({ txid: '0xwrongnetwork' })),
    };
    target.Neo = { DapiProvider: provider };

    await expect(
      invokeMorpheusOracleRequest({
        oracleHash: `0x${'11'.repeat(20)}`,
        requestType: 'privacy_oracle',
        payloadBase64: 'eyJ4IjoxfQ==',
        callbackHash: `0x${'22'.repeat(20)}`,
        callbackMethod: 'onOracleResult',
        expectedNetworkMagic: 894710606,
        expectedNetworkLabel: 'Neo N3 Testnet',
      })
    ).rejects.toThrow(/network magic 860833102/i);

    expect(provider.invoke).not.toHaveBeenCalled();
  });

  it('rejects wallet submissions when the current wallet network cannot be verified', async () => {
    const target = installWindow();
    const provider = {
      supportedNetworks: [860833102, 894710606],
      getAccounts: vi.fn(async () => [
        { hash: '0xuserhash', address: 'NUserAddress', isDefault: true },
      ]),
      invoke: vi.fn(async () => ({ txid: '0xunverifiednetwork' })),
    };
    target.Neo = { DapiProvider: provider };

    await expect(
      invokeMorpheusOracleRequest({
        oracleHash: `0x${'11'.repeat(20)}`,
        requestType: 'privacy_oracle',
        payloadBase64: 'eyJ4IjoxfQ==',
        callbackHash: `0x${'22'.repeat(20)}`,
        callbackMethod: 'onOracleResult',
        expectedNetworkMagic: 894710606,
        expectedNetworkLabel: 'Neo N3 Testnet',
      })
    ).rejects.toThrow(/network could not be verified/i);

    expect(provider.invoke).not.toHaveBeenCalled();
  });

  it('validates hashes, payload, callback method, and aborts faulty invokes before wallet submission', async () => {
    const target = installWindow();
    const provider = {
      network: 894710606,
      getAccounts: vi.fn(async () => [
        { hash: '0xuserhash', address: 'NUserAddress', isDefault: true },
      ]),
      invoke: vi.fn(async () => ({ txid: '0xinvalid' })),
    };
    target.Neo = { DapiProvider: provider };

    await expect(
      invokeMorpheusOracleRequest({
        oracleHash: '0xoracle',
        requestType: 'privacy_oracle',
        payloadBase64: 'eyJ4IjoxfQ==',
        callbackHash: `0x${'22'.repeat(20)}`,
        callbackMethod: 'onOracleResult',
      })
    ).rejects.toThrow(/oracle contract hash/i);

    await expect(
      invokeMorpheusOracleRequest({
        oracleHash: `0x${'11'.repeat(20)}`,
        requestType: 'privacy_oracle',
        payloadBase64: '',
        callbackHash: `0x${'22'.repeat(20)}`,
        callbackMethod: 'onOracleResult',
      })
    ).rejects.toThrow(/payload is empty/i);

    await expect(
      invokeMorpheusOracleRequest({
        oracleHash: `0x${'11'.repeat(20)}`,
        requestType: 'privacy_oracle',
        payloadBase64: 'eyJ4IjoxfQ==',
        callbackHash: `0x${'22'.repeat(20)}`,
        callbackMethod: '',
      })
    ).rejects.toThrow(/callback method/i);

    expect(provider.invoke).not.toHaveBeenCalled();
  });
});
