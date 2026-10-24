const HEX_PAYLOAD = /^(?:[0-9a-fA-F]{2})*$/;

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
  const payloadHex = requireRawPayloadHex(event);
  const payloadText = Object.prototype.hasOwnProperty.call(event, 'payloadText')
    ? String(event.payloadText ?? '')
    : String(event.payload ?? '');
  return { payloadText, payloadHex };
}
