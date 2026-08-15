// Helpers shared by the dashboard/studio snippet generators (OracleTab,
// ComputeTab, StarterStudio) for rendering copy-paste Neo N3 integration
// snippets. Kept in one place so the C#-string escaping and UTF-8 base64
// encoding stay byte-for-byte consistent across every generated snippet.

/** Escape a string for embedding inside a C# double-quoted string literal. */
export function escapeForCSharp(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * UTF-8 encode then base64 a string without blowing the call stack on large
 * payloads (chunked String.fromCharCode). Falls back to a Buffer when running
 * outside the browser so the helper is also safe under SSR/prerender.
 */
export function encodeUtf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (typeof window === 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

/** Copy text to the clipboard via the async Clipboard API. */
export function copyText(value: string) {
  return navigator.clipboard.writeText(value);
}

export interface NeoRequestInvokeParams {
  oracleContract: string;
  requestType: string;
  payloadBase64: string;
  callbackHash: string;
  callbackMethod: string;
}

/**
 * Build the Neo N3 `invokefunction` JSON an integrator pastes into an RPC call to
 * submit an oracle `request`. The field order and the JSON.stringify 2-space
 * indentation are the EXACT bytes users copy on-chain, so this must stay
 * byte-identical across the Oracle / Compute / Studio generators — hence one
 * builder rather than three inline copies that could silently drift.
 */
export function buildNeoRequestInvoke({
  oracleContract,
  requestType,
  payloadBase64,
  callbackHash,
  callbackMethod,
}: NeoRequestInvokeParams) {
  return JSON.stringify(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'invokefunction',
      params: [
        oracleContract,
        'request',
        [
          { type: 'String', value: requestType },
          { type: 'ByteArray', value: payloadBase64 },
          { type: 'Hash160', value: callbackHash },
          { type: 'String', value: callbackMethod },
        ],
      ],
    },
    null,
    2
  );
}

/**
 * Build the Neo N3 `invokefunction` JSON for reading a request's callback record
 * via `getCallback`. `<requestId>` is a placeholder the integrator substitutes
 * with the id returned by the request. Byte-identical across all three generators.
 */
export function buildCallbackQueryTemplate(callbackHash: string) {
  return JSON.stringify(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'invokefunction',
      params: [callbackHash, 'getCallback', [{ type: 'Integer', value: '<requestId>' }]],
    },
    null,
    2
  );
}

/**
 * Build the on-chain C# `Contract.Call` snippet a MiniApp uses to submit an oracle
 * `request`. `compactPayloadJson` is escaped for a C# string literal. Byte-identical
 * across the Oracle / Compute / Starter generators — the template whitespace is
 * load-bearing (it is shown to and copied verbatim by integrators).
 */
export function buildNeoRequestContractCall({
  requestType,
  compactPayloadJson,
}: {
  requestType: string;
  compactPayloadJson: string;
}) {
  return `string payloadJson = "${escapeForCSharp(compactPayloadJson)}";

BigInteger requestId = (BigInteger)Contract.Call(
 OracleHash,
 "request",
 CallFlags.All,
 "${requestType}",
 (ByteString)payloadJson,
 Runtime.ExecutingScriptHash,
 "onOracleResult"
);`;
}
