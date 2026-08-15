import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, createConsoleTransport, LEVELS } from './index.js';

function captureLogger(options = {}) {
  const records = [];
  const logger = createLogger({
    ...options,
    transports: [(record) => records.push(record)],
  });
  return { logger, records };
}

describe('shared logger', () => {
  it('exports createLogger, createConsoleTransport and LEVELS', () => {
    assert.equal(typeof createLogger, 'function');
    assert.equal(typeof createConsoleTransport, 'function');
    assert.equal(LEVELS.info, 20);
  });

  it('info with string message produces the expected JSON shape', () => {
    const { logger, records } = captureLogger({ level: 'info', service: 'test-service' });
    logger.info('hello world');
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.level, 'info');
    assert.equal(r.message, 'hello world');
    assert.equal(r.service, 'test-service');
    assert.equal(r.namespace, 'test-service');
    assert.equal(typeof r.timestamp, 'string');
    assert.ok(r.timestamp.length > 0);
  });

  it('info with message then metadata merges fields', () => {
    const { logger, records } = captureLogger({ level: 'info', service: 'test' });
    logger.info('request processed', { requestId: 'abc-123', durationMs: 42 });
    const r = records[0];
    assert.equal(r.message, 'request processed');
    assert.equal(r.requestId, 'abc-123');
    assert.equal(r.durationMs, 42);
  });

  it('info with metadata object then message works', () => {
    const { logger, records } = captureLogger({ level: 'info', service: 'test' });
    logger.info({ requestId: 'abc-123', durationMs: 42 }, 'request processed');
    const r = records[0];
    assert.equal(r.message, 'request processed');
    assert.equal(r.requestId, 'abc-123');
    assert.equal(r.durationMs, 42);
  });

  it('metadata and requestId merge from base fields and call fields', () => {
    const { logger, records } = captureLogger({
      level: 'info',
      service: 'test',
      baseFields: { requestId: 'base-123', correlationId: 'corr-1' },
    });
    logger.info('event', { extra: 'value' });
    const r = records[0];
    assert.equal(r.requestId, 'base-123');
    assert.equal(r.correlationId, 'corr-1');
    assert.equal(r.extra, 'value');
  });

  it('child logger inherits service and requestId', () => {
    const { logger, records } = captureLogger({
      level: 'info',
      service: 'test',
      baseFields: { requestId: 'parent-123' },
    });
    const child = logger.child({ component: 'worker' });
    child.info('child event');
    const r = records[0];
    assert.equal(r.service, 'test');
    assert.equal(r.namespace, 'test');
    assert.equal(r.requestId, 'parent-123');
    assert.equal(r.component, 'worker');
    assert.equal(r.message, 'child event');
  });

  it('child logger can override parent requestId', () => {
    const { logger, records } = captureLogger({
      level: 'info',
      service: 'test',
      baseFields: { requestId: 'parent-123' },
    });
    const child = logger.child({ requestId: 'child-456' });
    child.info('child event');
    const r = records[0];
    assert.equal(r.requestId, 'child-456');
  });

  it('log level filtering works', () => {
    const { logger, records } = captureLogger({ level: 'warn', service: 'test' });
    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    assert.equal(records.length, 2);
    assert.equal(records[0].message, 'warn msg');
    assert.equal(records[1].message, 'error msg');
  });

  it('redacts secret keys and applies string redactor', () => {
    const { logger, records } = captureLogger({
      level: 'info',
      service: 'test',
      redactKeys: [/token/i, 'password'],
      redactor: (value) => value.replace(/secret/g, '[REDACTED]'),
    });
    logger.info('event', {
      token: 'bearer-secret',
      password: 'abc',
      nested: { url: 'secret-value' },
    });
    const r = records[0];
    assert.equal(r.token, '[redacted]');
    assert.equal(r.password, '[redacted]');
    assert.equal(r.nested.url, '[REDACTED]-value');
  });

  it('serializes Error instances', () => {
    const { logger, records } = captureLogger({ level: 'info', service: 'test' });
    const err = new Error('boom');
    logger.info('failed', { err });
    const r = records[0];
    assert.equal(r.err.name, 'Error');
    assert.equal(r.err.message, 'boom');
    assert.equal(typeof r.err.stack, 'string');
  });
});
