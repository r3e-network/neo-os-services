import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimString } from './lib-strings.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultOracleRoot = path.resolve(moduleDir, '..');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadOptionalJson(filePath) {
  try {
    return loadJson(filePath);
  } catch {
    return null;
  }
}

function withNetworkSuffix(url, network) {
  const normalized = trimString(url).replace(/\/$/, '');
  if (!normalized) return '';
  if (normalized.endsWith(`/${network}`)) return normalized;
  return `${normalized}/${network}`;
}

function compactObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function resolveSupplementalHashes(network, oracleRoot) {
  if (network === 'mainnet') {
    const deployment = loadOptionalJson(
      path.join(oracleRoot, 'examples', 'deployments', 'mainnet.json')
    );
    return {
      aaSessionKeyVerifier:
        trimString(
          deployment?.neo_n3?.aa_subdomains?.['sessionkey.smartwallet.neo']?.contract_hash
        ) || trimString(deployment?.neo_n3?.aa_subdomains?.sessionkey?.contract_hash),
      aaAddressMarket:
        trimString(deployment?.neo_n3?.aa_address_market_hash) ||
        trimString(deployment?.neo_n3?.aa_subdomains?.['market.smartwallet.neo']?.contract_hash),
      aaPaymaster:
        trimString(deployment?.neo_n3?.aa_paymaster_hash) ||
        trimString(deployment?.neo_n3?.aa_subdomains?.['paymaster.smartwallet.neo']?.contract_hash),
    };
  }

  const validation = loadOptionalJson(
    path.join(oracleRoot, 'examples', 'deployments', 'testnet-cross-stack-validation.latest.json')
  );
  return {
    aaSessionKeyVerifier: trimString(validation?.shared_testnet_contracts?.aa_session_key_verifier),
    aaAddressMarket: trimString(validation?.shared_testnet_contracts?.aa_address_market),
    aaPaymaster: trimString(validation?.shared_testnet_contracts?.aa_paymaster),
  };
}

function buildContracts(network, rawRegistry, supplementalHashes) {
  const contracts = rawRegistry?.neo_n3?.contracts || {};
  const aaVerifiers = rawRegistry?.neo_n3?.aa_verifiers || {};

  return compactObject({
    aaCore: trimString(contracts.abstract_account),
    aaWeb3AuthVerifier: trimString(aaVerifiers.web3auth),
    aaSessionKeyVerifier:
      trimString(aaVerifiers.session_key) ||
      trimString(aaVerifiers.sessionkey) ||
      trimString(supplementalHashes.aaSessionKeyVerifier),
    aaSocialRecoveryVerifier: trimString(aaVerifiers.social_recovery),
    aaAddressMarket:
      trimString(contracts.aa_address_market) || trimString(supplementalHashes.aaAddressMarket),
    aaPaymaster: trimString(contracts.aa_paymaster) || trimString(supplementalHashes.aaPaymaster),
    morpheusOracle: trimString(contracts.morpheus_oracle),
    oracleCallbackConsumer: trimString(contracts.oracle_callback_consumer),
    morpheusDatafeed: trimString(contracts.morpheus_datafeed),
    morpheusNeoDid: trimString(contracts.morpheus_neodid),
  });
}

function buildDomains(rawRegistry) {
  const domains = rawRegistry?.neo_n3?.domains || {};
  const aaSubdomains = rawRegistry?.neo_n3?.aa_subdomains || {};

  return compactObject({
    aa: trimString(domains.morpheus_aa),
    aaAlias: trimString(domains.morpheus_aa_alias),
    aaCore: trimString(aaSubdomains.core),
    aaWeb3AuthVerifier: trimString(aaSubdomains.web3auth),
    aaSessionKeyVerifier: trimString(aaSubdomains.session),
    aaSocialRecoveryVerifier: trimString(aaSubdomains.recovery),
    aaAddressMarket: trimString(aaSubdomains.market),
    aaPaymaster: trimString(aaSubdomains.paymaster),
    oracle: trimString(domains.morpheus_oracle),
    callbackConsumer: trimString(domains.morpheus_callback_consumer),
    datafeed: trimString(domains.morpheus_datafeed),
    neodid: trimString(domains.morpheus_neodid),
  });
}

function buildMorpheusRuntime(network, rawRegistry) {
  const nitro = rawRegistry?.nitro ?? {};
  const publicApiUrl = trimString(nitro.public_api_url);
  const edgeUrl = trimString(nitro.edge_public_url);
  const controlPlaneBaseUrl = trimString(nitro.control_plane_url);
  const runtimeUrls = [publicApiUrl, edgeUrl].filter(Boolean);

  return {
    publicApiUrl,
    publicApiUrls: publicApiUrl ? [publicApiUrl] : [],
    runtimeUrl: publicApiUrl,
    runtimeUrls,
    edgeUrl,
    controlPlaneBaseUrl,
    controlPlaneUrl: withNetworkSuffix(controlPlaneBaseUrl, network),
    oracleCvmId: trimString(nitro.cvm_id),
    oracleCvmName: trimString(nitro.cvm_name),
    oracleAttestationExplorerUrl: trimString(nitro.oracle_attestation_explorer_url),
    datafeedCvmId: trimString(nitro.datafeed_cvm_id),
    datafeedCvmName: trimString(nitro.datafeed_cvm_name),
    datafeedAttestationExplorerUrl: trimString(nitro.datafeed_attestation_explorer_url),
    neoDidServiceDid: 'did:morpheus:neo_n3:service:neodid',
  };
}

function buildPublicNetworkEntry(network, rawRegistry, oracleRoot) {
  const supplementalHashes = resolveSupplementalHashes(network, oracleRoot);
  return {
    network,
    rpcUrl: trimString(rawRegistry?.neo_n3?.rpc_url),
    networkMagic: Number(rawRegistry?.neo_n3?.network_magic || 0),
    morpheus: buildMorpheusRuntime(network, rawRegistry),
    contracts: buildContracts(network, rawRegistry, supplementalHashes),
    domains: buildDomains(rawRegistry),
  };
}

export function loadPublicNetworkRegistry({ oracleRoot = defaultOracleRoot } = {}) {
  const out = {};
  for (const network of ['mainnet', 'testnet']) {
    const rawRegistry = loadJson(path.join(oracleRoot, 'config', 'networks', `${network}.json`));
    out[network] = buildPublicNetworkEntry(network, rawRegistry, oracleRoot);
  }
  return out;
}
