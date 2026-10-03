const GENERATED_SEGMENTS = Object.freeze([
  "dist",
  "dist-ssr",
  ".next",
  "node_modules",
  "coverage",
  ".turbo",
  ".cache",
  "out",
  "target",
  "bin",
  "obj",
  "build",
  "artifacts",
  "__pycache__",
]);

const GENERATED_SEGMENT_SET = new Set(GENERATED_SEGMENTS);
const GENERATED_PYTHON_BYTECODE_SUFFIX = ".pyc";
const REVIEWED_BUILD_PREFIXES = Object.freeze([
  "contracts-evm/build/",
  "vendor/neo-os-did/contracts/build/",
]);

export { GENERATED_SEGMENTS };

function isReviewedBuildInput(path) {
  return REVIEWED_BUILD_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isRustBinarySource(path) {
  const segments = path.split("/");
  return segments.some((segment, index) => segment === "src" && segments[index + 1] === "bin") &&
    path.endsWith(".rs");
}

export function trackedBuildOutputViolations(paths) {
  return [...new Set(
    paths.filter((entry) => {
      if (typeof entry !== "string" || entry.length === 0) return false;
      const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
      if (isReviewedBuildInput(normalized) || isRustBinarySource(normalized)) return false;
      return normalized.endsWith(GENERATED_PYTHON_BYTECODE_SUFFIX) ||
        normalized.split("/").some((segment) => GENERATED_SEGMENT_SET.has(segment));
    }),
  )].sort();
}
