import type { NetworkConfig } from '@/lib/dashboard-types';

import { getBrowserNetworkKey, getSelectedNetwork, getSelectedNetworkKey } from '@/lib/networks';

export function getDashboardNetworkConfig(networkOverride?: string | null): NetworkConfig {
  const networkKey = networkOverride
    ? getSelectedNetworkKey(networkOverride)
    : getBrowserNetworkKey();
  const selectedNetwork = getSelectedNetwork(networkKey);
  const neoN3 = selectedNetwork.neo_n3 || {};
  const contracts = neoN3.contracts || {};
  const domains = neoN3.domains || {};
  const examples = neoN3.examples || {};
  const label = networkKey === 'mainnet' ? 'Mainnet' : 'Testnet';

  return {
    networkKey,
    label,
    name: selectedNetwork.network === 'mainnet' ? 'Neo N3 Mainnet' : 'Neo N3 Testnet',
    networkMagic: Number(neoN3.network_magic || 0),
    oracleContract: contracts.morpheus_oracle || '',
    datafeedContract: contracts.morpheus_datafeed || '',
    callbackConsumer: examples.oracle_callback_consumer || contracts.oracle_callback_consumer || '',
    oracleDomain: domains.morpheus_oracle || '',
    datafeedDomain: domains.morpheus_datafeed || '',
    oracleAttestationExplorerUrl: selectedNetwork.nitro?.oracle_attestation_explorer_url || '',
    datafeedAttestationExplorerUrl: selectedNetwork.nitro?.datafeed_attestation_explorer_url || '',
  };
}

export function getContractExplorerUrl(networkKey: string, contract: string) {
  const normalizedContract = String(contract || '').trim();
  if (!normalizedContract) return '';
  const base =
    getSelectedNetworkKey(networkKey) === 'testnet'
      ? 'https://testnet.neotube.io/contract/'
      : 'https://neotube.io/contract/';
  return `${base}${normalizedContract}`;
}
