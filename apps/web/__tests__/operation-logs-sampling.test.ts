import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for operation-log volume controls:
 *  1. successful monitoring GETs (system/runtime/network/feed) are sampled
 *     1-in-N per route instead of writing a Supabase row per probe,
 *  2. failed monitoring GETs and non-GET traffic always log,
 *  3. upstream_candidates metadata is stripped from GET rows,
 *  4. /api/health responds without awaiting the log insert.
 */

const insertedRows: Array<Record<string, any>> = [];
const insert = vi.fn(async (row: Record<string, any>) => {
  insertedRows.push(row);
  return { error: null };
});
const getServerSupabaseClient = vi.fn(() => ({
  from: vi.fn(() => ({ insert })),
}));
const resolveProjectIdBySlug = vi.fn(async () => null);
const resolveSupabaseNetwork = vi.fn(() => 'testnet');
const emitBetterStackOperationLog = vi.fn();

vi.mock('@/lib/server-supabase', () => ({
  getServerSupabaseClient,
  resolveProjectIdBySlug,
  resolveSupabaseNetwork,
}));
vi.mock('@/lib/betterstack-log-sink', () => ({ emitBetterStackOperationLog }));

async function importModule() {
  const mod = await import('../lib/operation-logs');
  return { ...mod, flush: mod.flushPendingOperationLogs };
}

describe('operation log monitoring-read sampling', () => {
  beforeEach(() => {
    vi.resetModules();
    insertedRows.length = 0;
    insert.mockClear();
    emitBetterStackOperationLog.mockClear();
    delete process.env.MORPHEUS_OPERATION_LOG_SAMPLE_RATE;
  });

  it('samples successful monitoring GET probes 1-in-N per route', async () => {
    const { recordOperationLog, flush } = await importModule();
    for (let index = 0; index < 40; index += 1) {
      await recordOperationLog({
        route: '/api/runtime/status',
        method: 'GET',
        category: 'runtime',
        responsePayload: { ok: true },
        httpStatus: 200,
      });
    }
    await flush();
    // Default rate 20: probes 1 and 21 land, the other 38 are sampled out.
    expect(insertedRows.length).toBe(2);
    expect(emitBetterStackOperationLog).toHaveBeenCalledTimes(2);
  });

  it('tracks sampling counters per route', async () => {
    const { recordOperationLog, flush } = await importModule();
    for (const route of ['/api/health', '/api/onchain/state', '/api/feeds/status']) {
      await recordOperationLog({
        route,
        method: 'GET',
        category: route === '/api/health' ? 'system' : route.includes('feeds') ? 'feed' : 'network',
        responsePayload: { ok: true },
        httpStatus: 200,
      });
    }
    await flush();
    // First probe of each route always logs.
    expect(insertedRows.length).toBe(3);
  });

  it('honors MORPHEUS_OPERATION_LOG_SAMPLE_RATE overrides', async () => {
    process.env.MORPHEUS_OPERATION_LOG_SAMPLE_RATE = '5';
    const { recordOperationLog, flush } = await importModule();
    for (let index = 0; index < 10; index += 1) {
      await recordOperationLog({
        route: '/api/networks',
        method: 'GET',
        category: 'network',
        responsePayload: { ok: true },
        httpStatus: 200,
      });
    }
    await flush();
    expect(insertedRows.length).toBe(2);
  });

  it('always logs failed monitoring GETs', async () => {
    const { recordOperationLog, flush } = await importModule();
    for (let index = 0; index < 5; index += 1) {
      await recordOperationLog({
        route: '/api/onchain/state',
        method: 'GET',
        category: 'network',
        responsePayload: { ok: false },
        httpStatus: 503,
        error: 'chain read failed',
      });
    }
    await flush();
    expect(insertedRows.length).toBe(5);
  });

  it('never samples non-GET or non-monitoring traffic', async () => {
    const { recordOperationLog, flush } = await importModule();
    for (let index = 0; index < 5; index += 1) {
      await recordOperationLog({
        route: '/api/oracle/query',
        method: 'POST',
        category: 'oracle',
        requestPayload: { symbol: 'NEO-USD' },
        httpStatus: 200,
      });
      await recordOperationLog({
        route: '/api/relayer/jobs',
        method: 'GET',
        category: 'relayer',
        httpStatus: 200,
      });
    }
    await flush();
    expect(insertedRows.length).toBe(10);
  });

  it('strips upstream_candidates from GET rows but keeps it for mutations', async () => {
    const { recordOperationLog, flush } = await importModule();
    await recordOperationLog({
      route: '/api/runtime/status',
      method: 'GET',
      category: 'runtime',
      httpStatus: 200,
      metadata: { upstream_candidates: ['https://a.test', 'https://b.test'], network: 'testnet' },
    });
    await recordOperationLog({
      route: '/api/oracle/query',
      method: 'POST',
      category: 'oracle',
      httpStatus: 200,
      metadata: { upstream_candidates: ['https://a.test'], network: 'testnet' },
    });
    await flush();

    expect(insertedRows.length).toBe(2);
    const [getRow, postRow] = insertedRows;
    expect(getRow.metadata.upstream_candidates).toBeUndefined();
    expect(getRow.metadata.network).toBe('testnet');
    expect(postRow.metadata.upstream_candidates).toEqual(['https://a.test']);
  });

  it('does not mutate the caller-provided metadata object', async () => {
    const { recordOperationLog, flush } = await importModule();
    const metadata = { upstream_candidates: ['https://a.test'] };
    await recordOperationLog({
      route: '/api/runtime/status',
      method: 'GET',
      category: 'runtime',
      httpStatus: 200,
      metadata,
    });
    await flush();
    expect(metadata.upstream_candidates).toEqual(['https://a.test']);
  });
});

describe('/api/health logging decoupling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('responds even when the operation-log insert never settles', async () => {
    vi.doMock('@/lib/operation-logs', () => ({
      recordOperationLog: vi.fn(() => new Promise(() => {})),
    }));
    const { GET } = await import('../app/api/health/route');

    const outcome = await Promise.race([
      GET(),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);

    expect(outcome).not.toBe('timed-out');
    const body = await (outcome as Response).json();
    expect(body.status).toBe('ok');
    vi.doUnmock('@/lib/operation-logs');
  });
});
