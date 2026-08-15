import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { trimString } from './strings.js';
import { trimString as sharedTrimString } from '@r3e-network/neo-os-services-shared/utils';

// The relayer's trimString is intentionally STRICTER than the shared-package
// trimString: it returns '' for any non-string input rather than coercing via
// String(). This file pins that contract so the 12 relayer modules that now
// share this helper keep their original behavior, and so a future "just import
// the shared one" refactor is caught here (the shared variant coerces).
describe('relayer trimString', () => {
  it('trims surrounding whitespace on strings', () => {
    assert.equal(trimString('  hello  '), 'hello');
    assert.equal(trimString('\t\nvalue\r\n'), 'value');
    assert.equal(trimString('plain'), 'plain');
    assert.equal(trimString(''), '');
    assert.equal(trimString('   '), '');
  });

  it('collapses every non-string input to the empty string (no coercion)', () => {
    assert.equal(trimString(undefined), '');
    assert.equal(trimString(null), '');
    assert.equal(trimString(0), '');
    assert.equal(trimString(123), '');
    assert.equal(trimString(true), '');
    assert.equal(trimString(false), '');
    assert.equal(trimString(NaN), '');
    assert.equal(trimString(123n), '');
    assert.equal(trimString({}), '');
    assert.equal(trimString([]), '');
    assert.equal(trimString(['a']), '');
    assert.equal(
      trimString(() => 'x'),
      ''
    );
  });

  it('diverges from the shared trimString for non-string inputs (load-bearing)', () => {
    // The shared util coerces with String(value || '') — these are the exact
    // cases where swapping implementations would silently change relayer
    // encoding/settlement decisions.
    assert.equal(trimString(123), '');
    assert.equal(sharedTrimString(123), '123');

    assert.equal(trimString({ a: 1 }), '');
    assert.equal(sharedTrimString({ a: 1 }), '[object Object]');

    assert.equal(trimString(true), '');
    assert.equal(sharedTrimString(true), 'true');
  });

  it('agrees with the shared trimString for strings and falsy inputs', () => {
    for (const value of ['  x  ', 'y', '', '   ', undefined, null, 0, false, NaN]) {
      assert.equal(trimString(value), sharedTrimString(value));
    }
  });
});
