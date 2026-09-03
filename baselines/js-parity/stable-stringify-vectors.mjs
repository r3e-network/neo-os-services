/**
 * Golden vectors pinning the byte-for-byte output of `stableStringify` as the
 * nitro-worker produces it for `output_hash` digests (chain/signing.js hashes
 * `stableStringify(result)` before signing). Any implementation that feeds
 * those digest or verification paths MUST reproduce these strings exactly —
 * a single byte of drift breaks output-hash verification against live
 * signatures.
 *
 * Pinned semantics:
 * - `null`/`undefined` (top level and array entries) serialize as `null`;
 *   object entries with `undefined` values are dropped entirely.
 * - `bigint` serializes as its decimal string in quotes (`123n` -> `"123"`).
 * - Non-finite numbers follow JSON.stringify (`NaN`/`Infinity` -> `null`).
 * - Object keys sort via `String.prototype.localeCompare` — NOT code-unit
 *   order (`{Beta, alpha}` keeps `alpha` first). This matches every digest
 *   the worker has ever signed, so it must not be "fixed" to code-unit
 *   ordering without rotating the verification scheme.
 * - Typed arrays get no special casing: they serialize like plain objects
 *   with numeric string keys.
 *
 * The expected strings below were generated from
 * workers/nitro-worker/src/platform/core.js at the time the implementations
 * were consolidated into packages/shared.
 */
export const STABLE_STRINGIFY_GOLDEN_VECTORS = [
  { name: 'null', input: null, expected: 'null' },
  { name: 'top-level undefined', input: undefined, expected: 'null' },
  { name: 'string with quotes', input: 'hello "world"', expected: '"hello \\"world\\""' },
  { name: 'integer', input: 42, expected: '42' },
  { name: 'float', input: 0.1, expected: '0.1' },
  { name: 'negative zero', input: -0, expected: '0' },
  { name: 'NaN', input: NaN, expected: 'null' },
  { name: 'Infinity', input: Infinity, expected: 'null' },
  { name: 'boolean true', input: true, expected: 'true' },
  {
    name: 'bigint',
    input: 123456789012345678901234567890n,
    expected: '"123456789012345678901234567890"',
  },
  { name: 'empty object', input: {}, expected: '{}' },
  { name: 'empty array', input: [], expected: '[]' },
  { name: 'array with undefined entry', input: [1, undefined, 2], expected: '[1,null,2]' },
  {
    name: 'nested array and object',
    input: [1, 'two', [3, { b: 2, a: 1 }]],
    expected: '[1,"two",[3,{"a":1,"b":2}]]',
  },
  {
    name: 'object key sort lowercase',
    input: { beta: 2, alpha: 1, gamma: 3 },
    expected: '{"alpha":1,"beta":2,"gamma":3}',
  },
  {
    name: 'object mixed-case key collation (localeCompare, not code-unit)',
    input: { gamma: 3, Beta: 2, alpha: 1 },
    expected: '{"alpha":1,"Beta":2,"gamma":3}',
  },
  {
    name: 'object drops undefined values',
    input: { keep: 1, drop: undefined, alsoKeep: null },
    expected: '{"alsoKeep":null,"keep":1}',
  },
  { name: 'object with bigint value', input: { fee: 100000n }, expected: '{"fee":"100000"}' },
  {
    name: 'envelope-like result object',
    input: {
      status: 200,
      result: { price: '12.34', pair: 'NEO-USD', round_id: 7 },
      request_id: 'req:1',
      signature: null,
    },
    expected:
      '{"request_id":"req:1","result":{"pair":"NEO-USD","price":"12.34","round_id":7},"signature":null,"status":200}',
  },
  {
    name: 'unicode keys and values',
    input: { ключ: 'значение', 键: '值', emoji: '🚀' },
    expected: '{"emoji":"🚀","ключ":"значение","键":"值"}',
  },
  {
    name: 'uint8array treated as plain object',
    input: new Uint8Array([1, 2, 3]),
    expected: '{"0":1,"1":2,"2":3}',
  },
];
