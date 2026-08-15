import { trimString } from '../../platform/core.js';
import { FEED_PRICE_DECIMALS } from './shared.js';

export function decimalToIntegerString(value, decimals = FEED_PRICE_DECIMALS) {
  const raw = trimString(value);
  if (!raw) throw new Error('decimal value required');
  const sign = raw.startsWith('-') ? -1n : 1n;
  const normalized = raw.replace(/^[+-]/, '');
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error(`invalid decimal value: ${value}`);
  const [wholePart, fractionPart = ''] = normalized.split('.');
  const whole = BigInt(wholePart || '0');
  const fraction = (fractionPart + '0'.repeat(decimals)).slice(0, decimals);
  const fractionValue = BigInt(fraction || '0');
  const scale = 10n ** BigInt(decimals);
  return (whole * scale + fractionValue) * sign + '';
}

export function integerToDecimalString(value, decimals = FEED_PRICE_DECIMALS) {
  const raw = String(value ?? '0');
  const negative = raw.startsWith('-');
  const digits = raw.replace(/^[+-]/, '') || '0';
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals) || '0';
  const fraction = padded.slice(-decimals);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function multiplyDecimalString(value, multiplier = 1) {
  const raw = trimString(value);
  const factor = Number(multiplier);
  if (!raw) throw new Error('decimal value required');
  if (!Number.isFinite(factor) || factor <= 0) throw new Error(`invalid multiplier: ${multiplier}`);
  if (factor === 1) return raw;

  const sign = raw.startsWith('-') ? '-' : '';
  const normalized = raw.replace(/^[+-]/, '');
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error(`invalid decimal value: ${value}`);

  const [wholePart, fractionPart = ''] = normalized.split('.');
  const base = BigInt(`${wholePart}${fractionPart}` || '0');
  const scaled = base * BigInt(Math.trunc(factor));
  const digits = scaled.toString().padStart(fractionPart.length + 1, '0');
  const whole = fractionPart.length > 0 ? digits.slice(0, -fractionPart.length) : digits;
  const fraction =
    fractionPart.length > 0 ? digits.slice(-fractionPart.length).replace(/0+$/, '') : '';
  return `${sign}${fraction ? `${whole}.${fraction}` : whole}`;
}

function normalizeDecimalNumberString(value, precision = 12) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`invalid numeric value: ${value}`);
  return numeric.toFixed(precision).replace(/\.?0+$/, '');
}

export function transformDecimalString(value, { transform = '', multiplier = 1 } = {}) {
  let numeric = Number(trimString(value));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`invalid decimal value: ${value}`);
  }
  if (transform === 'inverse') {
    numeric = 1 / numeric;
  }
  if (Number(multiplier) !== 1) {
    numeric *= Number(multiplier);
  }
  return normalizeDecimalNumberString(numeric);
}
