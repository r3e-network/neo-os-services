import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A route that refuses an unsupported network label still records the
 * refusal. The operation log must not drop that row because the label cannot
 * be resolved: it files the row under the deployment's own network and keeps
 * the raw label in the request payload.
 */

const mocks = vi.hoisted(() => {
  const insertedRows: Array<Record<string, any>> = [];
  return {
    insertedRows,
    insert: vi.fn(async (row: Record<string, any>) => {
      insertedRows.push(row);
      return { error: null };
    }),
  };
});

vi.mock('@/lib/server-supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server-supabase')>()),
  getServerSupabaseClient: vi.fn(() => ({ from: vi.fn(() => ({ insert: mocks.insert })) })),
  resolveProjectIdBySlug: vi.fn(async () => null),
}));
vi.mock('@/lib/betterstack-log-sink', () => ({ emitBetterStackOperationLog: vi.fn() }));

describe('operation log network', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.insertedRows.length = 0;
    mocks.insert.mockClear();
    vi.stubEnv('MORPHEUS_NETWORK', 'mainnet');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records a refused unsupported label under the deployment network', async () => {
    const { recordOperationLog, flushPendingOperationLogs } = await import('../lib/operation-logs');
    await recordOperationLog({
      route: '/api/onchain/state',
      method: 'GET',
      category: 'network',
      requestPayload: { limit: 12, network: 'staging' },
      responsePayload: { error: 'unknown network' },
      httpStatus: 400,
      error: 'unknown network',
    });
    await flushPendingOperationLogs();

    expect(mocks.insertedRows).toHaveLength(1);
    expect(mocks.insertedRows[0].network).toBe('mainnet');
    expect(mocks.insertedRows[0].request_payload.network).toBe('staging');
    expect(mocks.insertedRows[0].http_status).toBe(400);
  });

  it('records a supported label under that network', async () => {
    const { recordOperationLog, flushPendingOperationLogs } = await import('../lib/operation-logs');
    await recordOperationLog({
      route: '/api/relayer/jobs',
      method: 'POST',
      category: 'relayer',
      requestPayload: { network: 'testnet' },
      httpStatus: 200,
    });
    await flushPendingOperationLogs();

    expect(mocks.insertedRows).toHaveLength(1);
    expect(mocks.insertedRows[0].network).toBe('testnet');
  });
});
