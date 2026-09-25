import { env, trimString } from './core.js';

const DEFAULT_MAX_SCRIPT_BYTES = 16 * 1024;
const DEFAULT_BLOCKED_PATTERNS = [
  { pattern: /\b(?:globalThis|global)\b/, message: 'global object access is not allowed' },
  { pattern: /\b(?:require|module|exports)\b/, message: 'module system access is not allowed' },
  {
    pattern: /\b(?:import\s*\(|import\s+[^('"])/,
    message: 'dynamic or static import is not allowed',
  },
  { pattern: /\b(?:Function|eval)\b/, message: 'dynamic code generation is not allowed' },
  {
    pattern: /\b(?:constructor|__proto__|prototype)\b/,
    message: 'prototype or constructor introspection is not allowed',
  },
  {
    pattern: /\b(?:WebAssembly|SharedArrayBuffer|Atomics)\b/,
    message: 'advanced runtime primitives are not allowed',
  },
  { pattern: /\b(?:fetch|XMLHttpRequest|WebSocket)\b/, message: 'network APIs are not allowed' },
  {
    pattern: /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\b/,
    message: 'async scheduling APIs are not allowed',
  },
  {
    pattern:
      /\b(?:process\s*\.\s*(?:env|mainModule|binding|constructor|stdin|stdout|stderr|kill|exit))/,
    message: 'process host access is not allowed',
  },
  {
    pattern: /\b(?:child_process|worker_threads|fs|http|https|net|tls|dgram|dns|vm)\b/,
    message: 'host runtime modules are not allowed',
  },
];

function resolveMaxScriptBytes() {
  return Math.max(Number(env('MORPHEUS_MAX_SCRIPT_BYTES') || DEFAULT_MAX_SCRIPT_BYTES), 1024);
}

export function validateUserScriptSource(script) {
  const source = trimString(script);
  if (!source) throw new Error('script required');

  const size = Buffer.byteLength(source, 'utf8');
  const maxBytes = resolveMaxScriptBytes();
  if (size > maxBytes) {
    throw new Error(`script exceeds max size of ${maxBytes} bytes`);
  }

  for (const rule of DEFAULT_BLOCKED_PATTERNS) {
    if (rule.pattern.test(source)) {
      throw new Error(rule.message);
    }
  }
}
