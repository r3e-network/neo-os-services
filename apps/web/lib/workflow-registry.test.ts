import { describe, expect, it } from 'vitest';

import {
  buildUserWorkflowId,
  isAllowedStatusTransition,
  sanitizeIdSegment,
  toPublicWorkflowRecord,
  validateHandlerSource,
  validateTriggerConfig,
  MAX_HANDLER_SOURCE_LENGTH,
  MIN_CRON_INTERVAL_SECONDS,
  type WorkflowRegistryRow,
} from './workflow-registry';
import { isPlatformWorkflowId, isUserRegistryWorkflowId } from './workflow-runtime';

describe('workflow id namespace', () => {
  it('sanitizes id segments to a safe [a-z0-9._-] form', () => {
    expect(sanitizeIdSegment('My Project!')).toBe('my-project');
    expect(sanitizeIdSegment('  ---acme---  ')).toBe('acme');
    expect(sanitizeIdSegment('a.b_c-d')).toBe('a.b_c-d');
  });

  it('collapses segments with no alphanumeric characters to empty', () => {
    expect(sanitizeIdSegment('!!!')).toBe('');
    expect(sanitizeIdSegment('---')).toBe('');
    expect(sanitizeIdSegment('中文')).toBe('');
  });

  it('never lets trigger_config.kind spoof the stored trigger kind', () => {
    const row: WorkflowRegistryRow = {
      id: 'id',
      project_id: 'project',
      workflow_id: 'user.mainnet.acme.price-watcher',
      name: 'Price Watcher',
      version: 1,
      status: 'active',
      trigger_kind: 'cron',
      trigger_config: { kind: 'http', interval_seconds: 300 },
      handler_source: null,
      target_chain: 'neo_n3',
      network: 'mainnet',
      metadata: {},
      created_at: '2026-08-13T00:00:00.000Z',
      updated_at: '2026-08-13T00:00:00.000Z',
    };
    const record = toPublicWorkflowRecord(row);
    expect(record.trigger).toMatchObject({ kind: 'cron', interval_seconds: 300 });
  });

  it('builds namespaced user workflow ids (network-scoped)', () => {
    expect(buildUserWorkflowId('Acme', 'Price Watcher', 'mainnet')).toBe(
      'user.mainnet.acme.price-watcher'
    );
    expect(buildUserWorkflowId('Acme', 'Price Watcher', 'testnet')).toBe(
      'user.testnet.acme.price-watcher'
    );
  });

  it('separates platform ids from user registry ids', () => {
    expect(isPlatformWorkflowId('oracle.query')).toBe(true);
    expect(isPlatformWorkflowId('user.mainnet.acme.price-watcher')).toBe(false);
    expect(isUserRegistryWorkflowId('user.mainnet.acme.price-watcher')).toBe(true);
  });
});

describe('status state machine', () => {
  it('allows draft -> active and active -> paused -> active', () => {
    expect(isAllowedStatusTransition('draft', 'active')).toBe(true);
    expect(isAllowedStatusTransition('active', 'paused')).toBe(true);
    expect(isAllowedStatusTransition('paused', 'active')).toBe(true);
  });

  it('allows soft delete from draft/active/paused', () => {
    expect(isAllowedStatusTransition('draft', 'deleted')).toBe(true);
    expect(isAllowedStatusTransition('active', 'deleted')).toBe(true);
    expect(isAllowedStatusTransition('paused', 'deleted')).toBe(true);
  });

  it('makes deleted terminal and rejects backward transitions', () => {
    expect(isAllowedStatusTransition('deleted', 'active')).toBe(false);
    expect(isAllowedStatusTransition('deleted', 'draft')).toBe(false);
    expect(isAllowedStatusTransition('paused', 'draft')).toBe(false);
    expect(isAllowedStatusTransition('active', 'draft')).toBe(false);
  });
});

describe('trigger config validation', () => {
  it('accepts a plain request trigger without config', () => {
    expect(validateTriggerConfig('request', {})).toBeNull();
  });

  it('enforces the cron floor aligned with CRE (>= 30s interval or 5-field cron)', () => {
    expect(validateTriggerConfig('cron', { interval_seconds: 30 })).toBeNull();
    expect(validateTriggerConfig('cron', { interval_seconds: 29 })).toMatch(/interval_seconds/);
    expect(validateTriggerConfig('cron', {})).toMatch(/cron|interval_seconds/);
    expect(validateTriggerConfig('cron', { cron: '*/5 * * * *' })).toBeNull();
    expect(validateTriggerConfig('cron', { cron: '*/5 * * *' })).toMatch(/5-field/);
  });

  it('validates http triggers (method + path)', () => {
    expect(validateTriggerConfig('http', { method: 'POST', path: '/hooks/price' })).toBeNull();
    expect(validateTriggerConfig('http', { method: 'PUT', path: '/x' })).toMatch(/GET or POST/);
    expect(validateTriggerConfig('http', { path: 'no-leading-slash' })).toMatch(/starting with/);
    expect(validateTriggerConfig('http', { path: '/hooks/../secret' })).toMatch(/".."/);
  });

  it('validates chain_event triggers', () => {
    expect(validateTriggerConfig('chain_event', { event_name: 'OracleRequested' })).toBeNull();
    expect(validateTriggerConfig('chain_event', {})).toMatch(/event_name/);
  });

  it('rejects non-object configs', () => {
    expect(validateTriggerConfig('request', 'nope')).toMatch(/JSON object/);
  });
});

describe('handler source validation', () => {
  it('accepts a function body and rejects non-function text', () => {
    expect(validateHandlerSource('function run(input) { return input.a; }')).toBeNull();
    expect(validateHandlerSource('return input.a;')).toMatch(/must define a function/);
    expect(validateHandlerSource('')).toBeNull(); // optional
    expect(validateHandlerSource(undefined)).toBeNull();
  });

  it('enforces the handler size cap', () => {
    const oversized = `function run(input) { /* ${'x'.repeat(MAX_HANDLER_SOURCE_LENGTH)} */ }`;
    expect(validateHandlerSource(oversized)).toMatch(/exceeds/);
    expect(MIN_CRON_INTERVAL_SECONDS).toBe(30);
  });
});
