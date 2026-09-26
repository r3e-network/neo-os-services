#!/usr/bin/env node
// Read-only unless --write is explicit. The per-network registry is authority.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderCSharpNetworkIdentities,
  renderRuntimeNetworkIdentities,
  projectProtocolNetwork,
} from './lib/network-identity-projections.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modes = process.argv.slice(2);
if (modes.length !== 1 || !['--check', '--check-local', '--write'].includes(modes[0]))
  throw new Error('use --check, --check-local or --write');
const mode = modes[0];
const networks = {};
for (const name of ['mainnet', 'testnet']) {
  const registry = JSON.parse(
    fs.readFileSync(path.join(root, 'config/networks', name + '.json'), 'utf8')
  );
  const {
    network_magic: magic,
    genesis_hash: genesisHash,
    genesis_source: provenance,
  } = registry.neo_n3;
  const neoXChainId = registry.neo_x?.chain_id;
  if (
    registry.network !== name ||
    !Number.isInteger(magic) ||
    magic <= 0 ||
    magic > 0xffffffff ||
    typeof genesisHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(genesisHash) ||
    /^0x0{64}$/.test(genesisHash) ||
    !provenance ||
    !Number.isSafeInteger(neoXChainId) ||
    neoXChainId <= 0
  )
    throw new Error(name + ': incomplete reviewed identity');
  networks[name] = { network: name, magic, genesisHash, provenance, neoXChainId };
}
const catalog = { schemaVersion: 1, networks };
// Preserve the existing cross-repository N3 projection contract. NeoX is
// emitted through the dedicated runtime projection below so consumers that
// have not yet adopted the wider registry shape do not silently drift.
const text =
  JSON.stringify(
    {
      schemaVersion: 1,
      networks: Object.fromEntries(
        Object.entries(networks).map(([name, entry]) => [
          name,
          {
            network: entry.network,
            magic: entry.magic,
            genesisHash: entry.genesisHash,
            provenance: entry.provenance,
          },
        ])
      ),
    },
    null,
    2
  ) + '\n';
const runtimeText = renderRuntimeNetworkIdentities(catalog);
const csharp = renderCSharpNetworkIdentities(catalog);
if (mode === '--check-local') {
  const localOutputs = [
    [path.join(root, 'config/generated/network-identities.v1.json'), text],
    [path.join(root, 'workers/nitro-worker/src/chain/network-identities.v1.json'), runtimeText],
    [path.join(root, 'config/generated/NeoN3NetworkIdentity.g.cs'), csharp],
  ];
  for (const [target, expected] of localOutputs) {
    if (fs.readFileSync(target, 'utf8') !== expected)
      throw new Error(path.basename(target) + ': local network identity projection drift');
  }
  console.log('local network identity projections match reviewed registry');
  process.exit(0);
}
const nativeRoot = path.join(root, '../neo-os-app');
const furaRoot = path.join(root, '../neo-os-fura');
const devpackRoot = path.join(root, '../neo-os-devpack');
// The Edge runtime cannot import across repositories, so it reads a vendored
// projection beside its own modules rather than a literal in each function.
const webRoot = path.join(root, '../neo-os-web');
const repositories = [root, nativeRoot, furaRoot, devpackRoot, webRoot];

// A generator may create directories within an existing consumer checkout, but
// must never invent a repository or follow its output through a symlink. Check
// every destination before the first write, including the Native input resource.
function requireRepository(repository) {
  let stat;
  try {
    stat = fs.lstatSync(repository);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(path.basename(repository) + ': consumer repository directory is missing');
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(
      path.basename(repository) + ': consumer repository must be an existing regular directory'
    );
}
function validateDestination(repository, target) {
  const relative = path.relative(repository, target);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('network identity output escapes its repository');
  const parts = relative.split(path.sep);
  let current = repository;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error(
        path.basename(repository) + ': network identity path must not follow symlinks'
      );
    const valid = index === parts.length - 1 ? stat.isFile() : stat.isDirectory();
    if (!valid)
      throw new Error(
        path.basename(repository) + ': network identity destination has an invalid file type'
      );
  }
}
for (const repository of repositories) requireRepository(repository);
const protocolPath = path.join(nativeRoot, 'NeoOS.App/Resources/Raw/protocol.json');
validateDestination(nativeRoot, protocolPath);
if (!fs.lstatSync(protocolPath).isFile()) throw new Error('Native protocol must be a regular file');
const protocolBytes = fs.readFileSync(protocolPath);
const protocolSource = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
  protocolBytes
);
const protocol = projectProtocolNetwork(protocolSource, networks.mainnet.magic);
// Build and validate every output before writing any projection.
const outputs = [
  {
    repository: root,
    target: path.join(root, 'config/generated/network-identities.v1.json'),
    text,
  },
  {
    repository: root,
    target: path.join(root, 'workers/nitro-worker/src/chain/network-identities.v1.json'),
    text: runtimeText,
  },
  {
    repository: furaRoot,
    target: path.join(furaRoot, 'supabase_indexer/internal/networkidentity/known-networks.json'),
    text,
  },
  {
    repository: devpackRoot,
    target: path.join(devpackRoot, 'shared/constants/generated-network-identities.json'),
    text,
  },
  {
    repository: webRoot,
    target: path.join(webRoot, 'platform/edge/functions/_shared/network-identities.v1.json'),
    text,
  },
  {
    repository: root,
    target: path.join(root, 'config/generated/NeoN3NetworkIdentity.g.cs'),
    text: csharp,
  },
  {
    repository: nativeRoot,
    target: path.join(nativeRoot, 'Shared/Generated/NeoN3NetworkIdentity.g.cs'),
    text: csharp,
  },
  { repository: nativeRoot, target: protocolPath, text: protocol },
];
for (const { repository, target } of outputs) validateDestination(repository, target);
if (!fs.readFileSync(protocolPath).equals(protocolBytes))
  throw new Error('Native protocol changed while planning; refusing writes');
for (const { target, text: output } of outputs) {
  if (mode === '--write') {
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === output) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output);
  } else if (fs.readFileSync(target, 'utf8') !== output)
    throw new Error(path.basename(target) + ': network identity projection drift');
}
console.log('network identity projections match reviewed registry');
