import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const NETWORKS = new Set(['mainnet', 'testnet']);

export function reviewedNetworkForEvmLabel(label = '') {
  const normalized = String(label).trim().toLowerCase();
  if (normalized === 'neox-testnet' || normalized === 'testnet') return 'testnet';
  if (normalized === 'neox-mainnet' || normalized === 'mainnet') return 'mainnet';
  throw new Error(`unsupported EVM network label: ${label}`);
}

export async function readReviewedNetworkRegistry(repoRoot, network) {
  if (!NETWORKS.has(network)) {
    throw new Error(`unsupported network registry: ${network}`);
  }
  const filePath = path.resolve(repoRoot, 'config/networks', `${network}.json`);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`cannot load reviewed network registry ${filePath}: ${error.message}`);
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse reviewed network registry ${filePath}: ${error.message}`);
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error(`reviewed network registry ${filePath} must be an object`);
  }
  if (registry.network !== network) {
    throw new Error(
      `reviewed network registry ${filePath} names ${registry.network || 'no network'}`
    );
  }
  reviewedNeoN3Magic(registry, network);
  reviewedNeoXChainId(registry, network);
  return registry;
}

export function readReviewedNetworkRegistrySync(repoRoot, network) {
  if (!NETWORKS.has(network)) {
    throw new Error(`unsupported network registry: ${network}`);
  }
  const filePath = path.resolve(repoRoot, 'config/networks', `${network}.json`);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`cannot load reviewed network registry ${filePath}: ${error.message}`);
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse reviewed network registry ${filePath}: ${error.message}`);
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error(`reviewed network registry ${filePath} must be an object`);
  }
  if (registry.network !== network) {
    throw new Error(
      `reviewed network registry ${filePath} names ${registry.network || 'no network'}`
    );
  }
  reviewedNeoN3Magic(registry, network);
  reviewedNeoXChainId(registry, network);
  return registry;
}

export function reviewedNeoN3Magic(registry, network) {
  const value = registry?.neo_n3?.network_magic;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new Error(`reviewed Neo N3 magic for ${network} must be a positive uint32`);
  }
  return String(value);
}

export function reviewedNeoXChainId(registry, network) {
  const value = registry?.neo_x?.chain_id;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`reviewed NeoX chain id for ${network} must be a positive safe integer`);
  }
  return String(value);
}

export function resolveReviewedNeoXChainId(registry, network, configuredValue = '') {
  const reviewed = reviewedNeoXChainId(registry, network);
  const configured = String(configuredValue || '').trim();
  if (configured && (!/^\d+$/.test(configured) || String(Number(configured)) !== reviewed)) {
    throw new Error(`configured NeoX chain id conflicts with reviewed ${network} identity`);
  }
  return reviewed;
}

export function resolveReviewedNeoN3Magic(registry, network, configuredValue = '') {
  const reviewed = reviewedNeoN3Magic(registry, network);
  const configured = String(configuredValue || '').trim();
  if (configured && (!/^\d+$/.test(configured) || String(Number(configured)) !== reviewed)) {
    throw new Error(`configured Neo N3 magic conflicts with reviewed ${network} identity`);
  }
  return reviewed;
}
