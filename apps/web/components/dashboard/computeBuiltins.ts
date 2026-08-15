// Canonical names of the builtin compute functions the authoring UI can emit. This is a
// subset of the shared `ComputeBuiltinFunction` union — kept local (not imported from
// `@r3e-network/neo-os-services-shared`) because that bare-index import drags the full shared
// index into the web app's strict typecheck, which currently fails on a transitive .js
// module that has no declaration file. The literals are checked against this union below.
type ComputeBuiltinName =
  | 'privacy.mask'
  | 'zkp.public_signal_hash'
  | 'zkp.groth16.verify'
  | 'zkp.zerc20.single_withdraw.verify'
  | 'math.modexp'
  | 'matrix.multiply';

// Single source of truth for the builtin compute functions the authoring UI emits, and
// how the selected function name maps to each canonical builtin. BOTH the authoring
// preview (buildSafeAuthoringPreview) and the generated on-chain package
// (generateOnchainPackage) resolve builtins through resolveBuiltinComputeFunction, so the
// two can never disagree: the package path previously had its own ladder that omitted
// groth16.verify and zerc20.single_withdraw.verify and silently emitted a `script` payload
// contradicting the `builtin` preview the user had just seen.
const BUILTIN_COMPUTE_MATCHERS: ReadonlyArray<{ match: string; fn: ComputeBuiltinName }> = [
  { match: 'privacy.mask', fn: 'privacy.mask' },
  { match: 'public_signal_hash', fn: 'zkp.public_signal_hash' },
  { match: 'groth16.verify', fn: 'zkp.groth16.verify' },
  { match: 'zerc20.single_withdraw.verify', fn: 'zkp.zerc20.single_withdraw.verify' },
  { match: 'modexp', fn: 'math.modexp' },
  { match: 'matrix', fn: 'matrix.multiply' },
];

/**
 * Resolve a selected compute-function name to its canonical builtin function, or null when
 * the selection is not a builtin (script / wasm / demo helpers). Used by every authoring
 * ladder so the builtin set can never drift between preview and on-chain package.
 */
export function resolveBuiltinComputeFunction(selectedFunc: string): ComputeBuiltinName | null {
  const hit = BUILTIN_COMPUTE_MATCHERS.find((entry) => selectedFunc.includes(entry.match));
  return hit ? hit.fn : null;
}
