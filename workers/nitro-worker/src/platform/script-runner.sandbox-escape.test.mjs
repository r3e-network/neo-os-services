import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS = 'true';

const { runScriptWithTimeout } = await import('./script-runner.js');

// The denylist in script-policy.js blocks the literal tokens `constructor` and
// `Function`, but a string-concatenated `constructor` slips past it. The real
// boundary is the sandbox: host objects passed in as data/context/input must be
// deep-cloned into the sandbox realm so the script cannot walk their prototype
// chain back to the parent realm's Function constructor.

test('oracle data argument cannot reach host process via concatenated constructor', async () => {
  const result = await runScriptWithTimeout({
    mode: 'oracle',
    script:
      'function process(d){var k="con"+"struct"+"or";return d[k][k]("return typeof process")();}',
    data: { probe: 1 },
    context: {},
    timeoutMs: 2000,
  }).catch((error) => ({ __threw: error.message }));

  if (result && typeof result === 'object' && '__threw' in result) {
    assert.match(
      result.__threw,
      /Code generation from strings disallowed|is not a function|undefined/
    );
  } else {
    assert.notEqual(result, 'object', 'escape reached host process');
  }
});

test('oracle context argument cannot reach host process via concatenated constructor', async () => {
  const result = await runScriptWithTimeout({
    mode: 'oracle',
    script:
      'function process(d, c){var k="con"+"struct"+"or";return c[k][k]("return typeof process")();}',
    data: {},
    context: { probe: 1 },
    timeoutMs: 2000,
  }).catch((error) => ({ __threw: error.message }));

  if (result && typeof result === 'object' && '__threw' in result) {
    assert.match(
      result.__threw,
      /Code generation from strings disallowed|is not a function|undefined/
    );
  } else {
    assert.notEqual(result, 'object', 'escape reached host process');
  }
});

test('compute input argument cannot reach host process via concatenated constructor', async () => {
  const result = await runScriptWithTimeout({
    mode: 'compute',
    entryPoint: 'process',
    script:
      'function process(input){var k="con"+"struct"+"or";return input[k][k]("return typeof process")();}',
    input: { probe: 1 },
    timeoutMs: 2000,
  }).catch((error) => ({ __threw: error.message }));

  if (result && typeof result === 'object' && '__threw' in result) {
    assert.match(
      result.__threw,
      /Code generation from strings disallowed|is not a function|undefined/
    );
  } else {
    assert.notEqual(result, 'object', 'escape reached host process');
  }
});

test('helpers function cannot reach host process via constructor chain', async () => {
  const result = await runScriptWithTimeout({
    mode: 'oracle',
    script:
      'function process(d, c, helpers){return helpers.base64Decode.constructor.constructor("return typeof process")();}',
    data: {},
    context: {},
    timeoutMs: 2000,
  }).catch((error) => ({ __threw: error.message }));

  if (result && typeof result === 'object' && '__threw' in result) {
    assert.match(
      result.__threw,
      /Code generation from strings disallowed|is not a function|undefined/
    );
  } else {
    assert.notEqual(result, 'object', 'escape reached host process');
  }
});

test('legitimate oracle script still receives data, context, and helpers', async () => {
  const result = await runScriptWithTimeout({
    mode: 'oracle',
    script:
      'function process(data, context, helpers){return {sum: data.a + data.b, label: context.label, decoded: helpers.base64Decode("aGVsbG8="), tsType: typeof helpers.getCurrentTimestamp()};}',
    data: { a: 2, b: 3 },
    context: { label: 'demo' },
    timeoutMs: 2000,
  });

  assert.deepEqual(result, {
    sum: 5,
    label: 'demo',
    decoded: 'hello',
    tsType: 'number',
  });
});

test('legitimate compute script still receives input and helpers', async () => {
  const result = await runScriptWithTimeout({
    mode: 'compute',
    entryPoint: 'process',
    script: 'function process(input, helpers){return input.value * 2;}',
    input: { value: 21 },
    timeoutMs: 2000,
  });

  assert.equal(result, 42);
});
