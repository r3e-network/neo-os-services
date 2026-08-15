import { trimString } from './lib-strings.mjs';
const GAS_DECIMALS = 8;
const GAS_FACTOR = 10n ** BigInt(GAS_DECIMALS);

/**
 * Parses a decimal GAS amount (e.g. '0.1') into raw 8-decimal base units as an
 * exact BigInt ('0.1' -> 10000000n).
 *
 * Replaces float parsing (`Math.ceil(Number(text) * 1e8)`): binary floating
 * point cannot represent most decimal GAS amounts, and the ceil that papered
 * over the truncation also overcharged whenever the product landed epsilon
 * ABOVE the exact value (e.g. '0.07' -> 7000001 instead of 7000000).
 *
 * Accepted inputs are non-negative plain decimals (optional leading '+').
 * Anything else - empty, negative, scientific or hex notation, stray
 * characters - returns `fallbackRaw`. Digits beyond the 8 supported decimals
 * round the result up by one base unit, preserving the previous ceil
 * semantics for minimum-budget thresholds.
 */
export function parseGasToRaw(value, fallbackRaw) {
  const text = trimString(value);
  if (!text) return fallbackRaw;
  const match = /^\+?(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return fallbackRaw;
  const whole = match[1];
  const fraction = match[2] || '';
  const kept = fraction.slice(0, GAS_DECIMALS).padEnd(GAS_DECIMALS, '0');
  let raw = BigInt(whole) * GAS_FACTOR + BigInt(kept);
  if (/[1-9]/.test(fraction.slice(GAS_DECIMALS))) raw += 1n;
  return raw;
}
