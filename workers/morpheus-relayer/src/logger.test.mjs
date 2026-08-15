import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger } from './logger.js';
import { clearLogSinkQueueForTests } from './betterstack-log-sink.js';

// The logger fans every log record out to the BetterStack sink (a module-level
// singleton configured via env). Drive batchSize=1 so each enqueued record
// flushes immediately, and stub global.fetch to capture the POSTed batch — that
// captured payload is exactly what would egress to the external sink.
const ENV_KEYS = [
  'MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST',
  'MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN',
  'MORPHEUS_BETTERSTACK_LOG_BATCH_SIZE',
];

describe('logger structured-log redaction', () => {
  let saved;
  let originalFetch;
  let captured;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST = 'logs.test';
    process.env.MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN = 'token';
    process.env.MORPHEUS_BETTERSTACK_LOG_BATCH_SIZE = '1'; // flush every record
    clearLogSinkQueueForTests();
    captured = [];
    originalFetch = global.fetch;
    global.fetch = async (_url, options) => {
      captured.push(...JSON.parse(options.body));
      return { ok: true };
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    clearLogSinkQueueForTests();
  });

  it('redacts URL string leaves at any nesting depth and secret-shaped key values', async () => {
    const logger = createLogger({ logFormat: 'json', logLevel: 'info' });
    logger.info(
      {
        rpc: 'https://user:pass@host/x',
        nested: { url: 'https://a.co/b?k=secret', wif: 'L1xxxx' },
      },
      'm'
    );
    // Allow the immediate flush() promise to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(captured.length, 1);
    const record = captured[0];
    assert.equal(record.message, 'm');
    // Top-level URL string leaf is scrubbed (prior behavior).
    assert.equal(record.rpc, '[redacted-url]');
    // Nested object/array string leaves are now scrubbed too.
    assert.equal(record.nested.url, '[redacted-url]');
    // Secret-shaped key value is redacted outright regardless of shape.
    assert.equal(record.nested.wif, '[redacted]');
    // The credential never reaches the captured payload in cleartext.
    assert.equal(JSON.stringify(record).includes('L1xxxx'), false);
    assert.equal(JSON.stringify(record).includes('pass@host'), false);
    assert.equal(JSON.stringify(record).includes('a.co'), false);
  });

  it('redacts URL string leaves inside arrays', async () => {
    const logger = createLogger({ logFormat: 'json', logLevel: 'info' });
    logger.warn({ endpoints: ['https://x.io/a', { token: 'tok-123' }] }, 'list');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(captured.length, 1);
    const record = captured[0];
    assert.equal(record.endpoints[0], '[redacted-url]');
    assert.equal(record.endpoints[1].token, '[redacted]');
    assert.equal(JSON.stringify(record).includes('tok-123'), false);
  });

  it('preserves existing Error serialization with scrubbed message and stack', async () => {
    const logger = createLogger({ logFormat: 'json', logLevel: 'error' });
    const err = new Error('failed calling https://user:pass@host/rpc');
    logger.error({ err }, 'boom');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(captured.length, 1);
    const record = captured[0];
    assert.equal(record.err.name, 'Error');
    assert.equal(record.err.message, 'failed calling [redacted-url]');
    assert.equal(typeof record.err.stack, 'string');
    assert.equal(JSON.stringify(record).includes('pass@host'), false);
  });
});
