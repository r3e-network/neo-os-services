const GENERATED_SEGMENTS = Object.freeze([
  'dist',
  'dist-ssr',
  '.next',
  'node_modules',
  'coverage',
  '.turbo',
  '.cache',
  'out',
  'target',
  'bin',
  'obj',
  'build',
  'artifacts',
  '__pycache__',
]);

const GENERATED_SEGMENT_SET = new Set(GENERATED_SEGMENTS);
const GENERATED_PYTHON_BYTECODE_SUFFIX = '.pyc';
const REVIEWED_BUILD_PATHS = new Set([
  'contracts-evm/build/MiniAppCreditsV2.abi.json',
  'contracts-evm/build/MiniAppDiceGameEVM.abi.json',
  'contracts-evm/build/MiniAppDiceGameEVM.neox-mainnet.json',
  'contracts-evm/build/MiniAppMessageEVM.abi.json',
  'contracts-evm/build/MiniAppMessageEVM.neox-mainnet.json',
  'contracts-evm/build/MorpheusOracleEVM.abi.json',
  'contracts-evm/build/MorpheusOracleEVM.neox-mainnet.json',
  'contracts-evm/build/MorpheusPriceFeed.abi.json',
  'contracts-evm/build/MorpheusPriceFeed.neox-mainnet.json',
  'vendor/neo-os-did/contracts/build/NeoDIDRegistry.manifest.json',
  'vendor/neo-os-did/contracts/build/NeoDIDRegistry.nef',
]);

export { GENERATED_SEGMENTS };

function normalizePath(path) {
  return path
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

function isRustBinarySource(path) {
  const segments = path.split('/');
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const sourceIndex = lowerSegments.lastIndexOf('src');
  return (
    sourceIndex >= 0 &&
    lowerSegments[sourceIndex + 1] === 'bin' &&
    segments.length === sourceIndex + 3 &&
    lowerSegments[sourceIndex + 2].endsWith('.rs') &&
    !lowerSegments.slice(0, sourceIndex).some((segment) => GENERATED_SEGMENT_SET.has(segment))
  );
}

export function trackedBuildOutputViolations(paths) {
  return [
    ...new Set(
      paths.filter((entry) => {
        if (typeof entry !== 'string' || entry.length === 0) return false;
        const normalized = normalizePath(entry);
        const lower = normalized.toLowerCase();
        if (REVIEWED_BUILD_PATHS.has(normalized) || isRustBinarySource(normalized)) return false;
        return (
          lower.endsWith(GENERATED_PYTHON_BYTECODE_SUFFIX) ||
          lower.split('/').some((segment) => GENERATED_SEGMENT_SET.has(segment))
        );
      })
    ),
  ].sort();
}
