import { DEFAULT_FEED_SYMBOLS } from './feed-defaults';
import { getSelectedNetwork, getSelectedNetworkKey } from './networks';

export const DEFAULT_PAIRS = [...DEFAULT_FEED_SYMBOLS];
const selectedNetwork = getSelectedNetwork();
const selectedDomains: Record<string, string | undefined> = selectedNetwork.neo_n3?.domains || {};
export const SELECTED_NETWORK_KEY = getSelectedNetworkKey();
export const SELECTED_NETWORK_LABEL = SELECTED_NETWORK_KEY === 'mainnet' ? 'Mainnet' : 'Testnet';
export const NETWORKS = {
  selected: {
    key: SELECTED_NETWORK_KEY,
    label: SELECTED_NETWORK_LABEL,
    nitroApiUrl: selectedNetwork.nitro?.public_api_url || '',
    nitroCvmId: selectedNetwork.nitro?.cvm_id || '',
    nitroCvmName: selectedNetwork.nitro?.cvm_name || '',
    nitroEdgeUrl: selectedNetwork.nitro?.edge_public_url || '',
    nitroControlPlaneUrl: selectedNetwork.nitro?.control_plane_url || '',
    oracleAttestationExplorerUrl: selectedNetwork.nitro?.oracle_attestation_explorer_url || '',
    datafeedCvmId: selectedNetwork.nitro?.datafeed_cvm_id || '',
    datafeedCvmName: selectedNetwork.nitro?.datafeed_cvm_name || '',
    datafeedAttestationExplorerUrl: selectedNetwork.nitro?.datafeed_attestation_explorer_url || '',
  },
  neo_n3: {
    name: selectedNetwork.network === 'mainnet' ? 'Neo N3 Mainnet' : 'Neo N3 Testnet',
    networkKey: SELECTED_NETWORK_KEY,
    environmentLabel: SELECTED_NETWORK_LABEL,
    rpc: selectedNetwork.neo_n3?.rpc_url || '',
    oracle: selectedNetwork.neo_n3?.contracts?.morpheus_oracle || '',
    callbackConsumer: selectedNetwork.neo_n3?.contracts?.oracle_callback_consumer || '',
    datafeed: selectedNetwork.neo_n3?.contracts?.morpheus_datafeed || '',
    aa: selectedNetwork.neo_n3?.contracts?.abstract_account || '',
    neodid: selectedNetwork.neo_n3?.contracts?.morpheus_neodid || '',
    exampleConsumer: selectedNetwork.neo_n3?.examples?.oracle_callback_consumer || '',
    exampleFeedReader: selectedNetwork.neo_n3?.examples?.feed_reader || '',
    nitroApiUrl: selectedNetwork.nitro?.public_api_url || '',
    nitroCvmId: selectedNetwork.nitro?.cvm_id || '',
    nitroCvmName: selectedNetwork.nitro?.cvm_name || '',
    nitroEdgeUrl: selectedNetwork.nitro?.edge_public_url || '',
    nitroControlPlaneUrl: selectedNetwork.nitro?.control_plane_url || '',
    oracleAttestationExplorerUrl: selectedNetwork.nitro?.oracle_attestation_explorer_url || '',
    datafeedCvmId: selectedNetwork.nitro?.datafeed_cvm_id || '',
    datafeedCvmName: selectedNetwork.nitro?.datafeed_cvm_name || '',
    datafeedAttestationExplorerUrl: selectedNetwork.nitro?.datafeed_attestation_explorer_url || '',
    explorer:
      selectedNetwork.network === 'mainnet'
        ? 'https://neotube.io/contract/'
        : 'https://testnet.neotube.io/contract/',
    domains: {
      oracle: selectedDomains.morpheus_oracle || '',
      callbackConsumer: selectedDomains.morpheus_callback_consumer || '',
      datafeed: selectedDomains.morpheus_datafeed || '',
      aa: selectedDomains.morpheus_aa || '',
      aaAlias: selectedDomains.morpheus_aa_alias || '',
      neodid: selectedNetwork.neo_n3?.domains?.morpheus_neodid || '',
    },
  },
};
