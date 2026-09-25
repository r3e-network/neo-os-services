import fs from 'node:fs';
import path from 'node:path';

export function loadNetworkMagics(repositoryRoot) {
  const result = {};
  for (const network of ['mainnet', 'testnet']) {
    const configPath = path.join(repositoryRoot, 'config', 'networks', `${network}.json`);
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`cannot read ${network} network registry: ${error.message}`);
    }
    const magic = config?.neo_n3?.network_magic;
    if (!Number.isSafeInteger(magic) || magic <= 0) {
      throw new Error(`invalid network_magic for ${network} network registry`);
    }
    result[network] = String(magic);
  }
  return Object.freeze(result);
}
