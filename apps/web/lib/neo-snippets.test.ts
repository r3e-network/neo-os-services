import { describe, expect, it } from 'vitest';

import {
  buildCallbackQueryTemplate,
  buildNeoRequestContractCall,
  buildNeoRequestInvoke,
} from './neo-snippets';

// These strings are what integrators copy/paste into a Neo N3 RPC call, so the
// exact bytes (field order + 2-space indentation) are load-bearing. The literals
// below are the verbatim output the Oracle / Compute / Studio generators produced
// from their (previously triplicated) inline builders — they pin byte-identity so
// the shared builder can never silently drift from what users paste on-chain.

describe('buildNeoRequestInvoke', () => {
  it('produces the exact invokefunction request snippet', () => {
    const snippet = buildNeoRequestInvoke({
      oracleContract: '0xoracle',
      requestType: 'privacy.oracle',
      payloadBase64: 'eyJrIjoidiJ9',
      callbackHash: '0xcallback',
      callbackMethod: 'onOracleResult',
    });
    expect(snippet).toBe(
      `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "invokefunction",
  "params": [
    "0xoracle",
    "request",
    [
      {
        "type": "String",
        "value": "privacy.oracle"
      },
      {
        "type": "ByteArray",
        "value": "eyJrIjoidiJ9"
      },
      {
        "type": "Hash160",
        "value": "0xcallback"
      },
      {
        "type": "String",
        "value": "onOracleResult"
      }
    ]
  ]
}`
    );
  });

  it('threads each parameter into its slot', () => {
    const parsed = JSON.parse(
      buildNeoRequestInvoke({
        oracleContract: '0xabc',
        requestType: 'compute',
        payloadBase64: 'BASE64',
        callbackHash: '0xcb',
        callbackMethod: 'cb',
      })
    );
    expect(parsed.method).toBe('invokefunction');
    expect(parsed.params[0]).toBe('0xabc');
    expect(parsed.params[1]).toBe('request');
    expect(parsed.params[2]).toEqual([
      { type: 'String', value: 'compute' },
      { type: 'ByteArray', value: 'BASE64' },
      { type: 'Hash160', value: '0xcb' },
      { type: 'String', value: 'cb' },
    ]);
  });
});

describe('buildCallbackQueryTemplate', () => {
  it('produces the exact getCallback query snippet', () => {
    expect(buildCallbackQueryTemplate('0xcallback')).toBe(
      `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "invokefunction",
  "params": [
    "0xcallback",
    "getCallback",
    [
      {
        "type": "Integer",
        "value": "<requestId>"
      }
    ]
  ]
}`
    );
  });
});

describe('buildNeoRequestContractCall', () => {
  it('produces the exact on-chain Contract.Call snippet (whitespace is load-bearing)', () => {
    const snippet = buildNeoRequestContractCall({
      requestType: 'oracle',
      compactPayloadJson: '{}',
    });
    expect(snippet).toBe(
      `string payloadJson = "{}";

BigInteger requestId = (BigInteger)Contract.Call(
 OracleHash,
 "request",
 CallFlags.All,
 "oracle",
 (ByteString)payloadJson,
 Runtime.ExecutingScriptHash,
 "onOracleResult"
);`
    );
  });

  it('escapes double-quotes in the payload for the C# string literal', () => {
    const snippet = buildNeoRequestContractCall({
      requestType: 'compute',
      compactPayloadJson: '{"k":"v"}',
    });
    expect(snippet).toContain('string payloadJson = "{\\"k\\":\\"v\\"}";');
    expect(snippet).toContain('"compute"');
  });
});
