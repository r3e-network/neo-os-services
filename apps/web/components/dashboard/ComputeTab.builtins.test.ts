import { describe, expect, it } from 'vitest';

import { resolveBuiltinComputeFunction } from './computeBuiltins';

// Both the authoring preview (buildSafeAuthoringPreview) and the generated on-chain
// package (generateOnchainPackage) resolve builtins through resolveBuiltinComputeFunction.
// Regression guard: generateOnchainPackage previously had its own ladder that omitted
// groth16.verify and zerc20.single_withdraw.verify, so those two fell through to a
// `script` payload that disagreed with the `builtin` preview the user saw. Pinning the
// single resolver here makes that drift impossible — if a builtin is recognized at all,
// both ladders recognize it identically.

describe('resolveBuiltinComputeFunction', () => {
  it('maps every authoring builtin selector to its canonical function name', () => {
    expect(resolveBuiltinComputeFunction('privacy.mask')).toBe('privacy.mask');
    expect(resolveBuiltinComputeFunction('zkp.public_signal_hash')).toBe('zkp.public_signal_hash');
    expect(resolveBuiltinComputeFunction('math.modexp')).toBe('math.modexp');
    expect(resolveBuiltinComputeFunction('matrix.multiply')).toBe('matrix.multiply');
  });

  it('recognizes the two ZKP builtins the package path used to silently drop', () => {
    // These are the regression: previously builtin in the preview, `script` in the package.
    expect(resolveBuiltinComputeFunction('zkp.groth16.verify')).toBe('zkp.groth16.verify');
    expect(resolveBuiltinComputeFunction('zkp.zerc20.single_withdraw.verify')).toBe(
      'zkp.zerc20.single_withdraw.verify'
    );
  });

  it('does not match groth16.prove.plan as groth16.verify', () => {
    // groth16.prove.plan is NOT a builtin-payload function here; it must not be caught by
    // the groth16.verify matcher (substring discipline).
    expect(resolveBuiltinComputeFunction('zkp.groth16.prove.plan')).toBeNull();
  });

  it('returns null for non-builtin (script/wasm/demo) selectors', () => {
    expect(resolveBuiltinComputeFunction('timestamp')).toBeNull();
    expect(resolveBuiltinComputeFunction('base64_decode')).toBeNull();
    expect(resolveBuiltinComputeFunction('wasm')).toBeNull();
    expect(resolveBuiltinComputeFunction('custom.script')).toBeNull();
    expect(resolveBuiltinComputeFunction('')).toBeNull();
  });
});
