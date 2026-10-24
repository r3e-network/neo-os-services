import { trimString } from './strings.js';

const HEX_PAYLOAD = /^(?:[0-9a-fA-F]{2})*$/;

export function decodeJsonObjectPayload(rawPayload, { allowNonObject = false } = {}) {
  const text = trimString(rawPayload);
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { raw_payload: text };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (allowNonObject) return {};
    throw new Error('request payload must be a JSON object');
  }
  return parsed;
}

export function requireRawPayloadHex(holder, field = 'payloadHex') {
  if (
    !holder ||
    typeof holder !== 'object' ||
    !Object.prototype.hasOwnProperty.call(holder, field)
  ) {
    throw new Error(`${field} is required for fulfillment signing`);
  }
  const value = holder[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required for fulfillment signing`);
  }
  const normalized = value.trim();
  const bare = normalized.replace(/^0x/i, '');
  if (!HEX_PAYLOAD.test(bare) || (!bare && !/^0x$/i.test(normalized))) {
    throw new Error(
      `${field} must be even-length hexadecimal (use 0x for an explicit empty payload)`
    );
  }
  return normalized;
}

export function resolveEventPayload(event = {}) {
  const hasCamel = Object.prototype.hasOwnProperty.call(event, 'payloadHex');
  const hasSnake = Object.prototype.hasOwnProperty.call(event, 'payload_hex');
  if (!hasCamel && !hasSnake) requireRawPayloadHex(event);
  const camel = hasCamel ? requireRawPayloadHex(event) : null;
  const snake = hasSnake ? requireRawPayloadHex(event, 'payload_hex') : null;
  if (camel !== null && snake !== null && camel !== snake) {
    throw new Error('payloadHex aliases disagree');
  }
  const payloadHex = camel ?? snake;
  const payloadText = Object.prototype.hasOwnProperty.call(event, 'payloadText')
    ? String(event.payloadText ?? '')
    : String(event.payload ?? '');
  return { payloadText, payloadHex };
}
