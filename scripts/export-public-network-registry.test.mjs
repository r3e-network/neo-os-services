import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicNetworkRegistry } from './lib-public-network-registry.mjs';

test('public network registry export exposes canonical Morpheus runtime metadata', () => {
  const registry = loadPublicNetworkRegistry();
  assert.equal(registry.mainnet.network, 'mainnet');
  assert.equal(registry.mainnet.rpcUrl, 'https://api.n3index.dev/mainnet');
  assert.equal(registry.testnet.rpcUrl, 'https://api.n3index.dev/testnet');
  assert.equal(registry.mainnet.morpheus.publicApiUrl, 'https://oracle.meshmini.app/mainnet');
  assert.equal(registry.mainnet.morpheus.controlPlaneUrl, 'https://control.meshmini.app/mainnet');
  assert.deepEqual(registry.mainnet.morpheus.runtimeUrls, [
    'https://oracle.meshmini.app/mainnet',
    'https://edge.meshmini.app/mainnet',
  ]);
  assert.equal(registry.mainnet.morpheus.datafeedCvmId, 'ac5b6886a2832df36e479294206611652400178f');
  assert.equal(registry.testnet.morpheus.datafeedAttestationExplorerUrl, '');
  assert.equal(registry.mainnet.contracts.aaCore, '0x0268a387913b250166ddec032b03332690a1ef78');
  assert.equal(
    registry.mainnet.contracts.aaWeb3AuthVerifier,
    '0xf5c452cd4ba29dcdc47026383568c0d8b38d9272'
  );
  assert.equal(
    registry.mainnet.contracts.aaSessionKeyVerifier,
    '0x3ba8333406e59f9fd83cf378b33706a33d9f3755'
  );
  assert.equal(
    registry.mainnet.contracts.aaSocialRecoveryVerifier,
    '0x198b3a9cec9bccc2110d19bd929b10374a9d034d'
  );
  assert.equal(
    registry.mainnet.contracts.aaAddressMarket,
    '0xae7afe3a85ab08bfd1d4907b35ae8b80c75b3a69'
  );
  assert.equal(
    registry.mainnet.contracts.aaPaymaster,
    '0xa0defa2bc6d7a71ba1e237149287c8ca4ff46caf'
  );
  assert.equal(registry.mainnet.domains.aaPaymaster, 'paymaster.smartwallet.neo');
  assert.equal(registry.mainnet.domains.callbackConsumer, 'callback.morpheus.neo');
  assert.equal(
    registry.mainnet.contracts.oracleCallbackConsumer,
    '0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844'
  );
  assert.equal(
    registry.testnet.contracts.morpheusOracle,
    '0xf54d8584ef82315c1800373272ab08ae0db2d5ef'
  );
  assert.equal(
    registry.testnet.contracts.oracleCallbackConsumer,
    '0x8c506f224d82e67200f20d9d5361f767f0756e3b'
  );
});
