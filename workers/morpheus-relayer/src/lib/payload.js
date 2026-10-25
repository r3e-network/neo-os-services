import { ethers } from 'ethers';
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

function derivePayloadText(payloadHex, chain, confidential) {
  const bytes = Buffer.from(payloadHex.replace(/^0x/i, ''), 'hex');
  if (confidential && chain === 'neox') {
    try {
      const [messageId, envelopeBytes] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint256', 'bytes'],
        ethers.getBytes(payloadHex.startsWith('0x') ? payloadHex : `0x${payloadHex}`)
      );
      return { text: ethers.toUtf8String(envelopeBytes), messageId: messageId.toString() };
    } catch {
      // A raw-envelope payload remains a separate, explicit compatibility form.
    }
  }
  return {
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    messageId: null,
  };
}

function suppliedPayloadText(event) {
  const hasText = Object.prototype.hasOwnProperty.call(event, 'payloadText');
  const hasPayload = Object.prototype.hasOwnProperty.call(event, 'payload');
  const read = (field) => {
    if (typeof event[field] !== 'string') throw new Error(`${field} must be a string`);
    return event[field];
  };
  const text = hasText ? read('payloadText') : hasPayload ? read('payload') : null;
  if (hasText && hasPayload && read('payload') !== text) {
    throw new Error('payloadText aliases disagree');
  }
  return text;
}

export function resolveEventPayload(event = {}, { chain = event.chain, confidential } = {}) {
  const hasCamel = Object.prototype.hasOwnProperty.call(event, 'payloadHex');
  const hasSnake = Object.prototype.hasOwnProperty.call(event, 'payload_hex');
  if (!hasCamel && !hasSnake) requireRawPayloadHex(event);
  const camel = hasCamel ? requireRawPayloadHex(event) : null;
  const snake = hasSnake ? requireRawPayloadHex(event, 'payload_hex') : null;
  if (camel !== null && snake !== null && camel !== snake) {
    throw new Error('payloadHex aliases disagree');
  }
  const payloadHex = camel ?? snake;
  const normalizedRequestType = trimString(event.requestType)
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const isConfidential =
    confidential ??
    (normalizedRequestType === 'decrypt' ||
      normalizedRequestType.includes('decrypt') ||
      normalizedRequestType.includes('reveal'));
  const derived = derivePayloadText(payloadHex, chain, isConfidential);
  const suppliedText = suppliedPayloadText(event);
  const rawLength = Buffer.from(payloadHex.replace(/^0x/i, ''), 'hex').length;
  if (rawLength > 0 && suppliedText === null) {
    throw new Error('payloadText is required when payloadHex is non-empty');
  }
  if (suppliedText !== null && suppliedText !== derived.text) {
    throw new Error('payloadText does not match payloadHex');
  }
  if (rawLength > 0 && derived.text === '') {
    throw new Error('payloadText must not be empty when payloadHex is non-empty');
  }
  const payloadText = derived.text;
  decodeJsonObjectPayload(payloadText, { allowNonObject: isConfidential });
  return { payloadText, payloadHex, messageId: derived.messageId };
}
