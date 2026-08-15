import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetServerSupabaseCachesForTests,
  loadProjectProviderConfig,
  resolveProjectIdBySlug,
} from '../lib/server-supabase';

const originalLookupCacheTtl = process.env.MORPHEUS_WEB_LOOKUP_CACHE_TTL_MS;

type QueryResult = {
  data: any;
  error: any;
};

function createFakeSupabase({
  projectId = 'project-1',
  providerConfig = {
    provider_id: 'twelvedata',
    enabled: true,
    config: { pair: 'NEO-USD' },
  },
}: {
  projectId?: string | null;
  providerConfig?: Record<string, unknown> | null;
} = {}) {
  const counts = {
    projectLookups: 0,
    providerLookups: 0,
  };

  const buildQuery = (table: string) => {
    const filters: Record<string, string> = {};
    return {
      select() {
        return this;
      },
      eq(field: string, value: string) {
        filters[field] = value;
        return this;
      },
      async maybeSingle(): Promise<QueryResult> {
        if (table === 'morpheus_projects') {
          counts.projectLookups += 1;
          return {
            data: projectId
              ? {
                  id: projectId,
                  slug: filters.slug || 'demo',
                  network: filters.network || 'testnet',
                }
              : null,
            error: null,
          };
        }

        if (table === 'morpheus_provider_configs') {
          counts.providerLookups += 1;
          return {
            data: providerConfig,
            error: null,
          };
        }

        throw new Error(`unexpected table ${table}`);
      },
    };
  };

  return {
    counts,
    client: {
      from(table: string) {
        return buildQuery(table);
      },
    },
  };
}

describe('server supabase lookup caches', () => {
  beforeEach(() => {
    process.env.MORPHEUS_WEB_LOOKUP_CACHE_TTL_MS = '30000';
    __resetServerSupabaseCachesForTests();
  });

  afterEach(() => {
    if (originalLookupCacheTtl === undefined) {
      delete process.env.MORPHEUS_WEB_LOOKUP_CACHE_TTL_MS;
    } else {
      process.env.MORPHEUS_WEB_LOOKUP_CACHE_TTL_MS = originalLookupCacheTtl;
    }
  });

  it('caches project ids by network and slug', async () => {
    const fake = createFakeSupabase();

    const first = await resolveProjectIdBySlug(fake.client as any, 'demo', 'testnet');
    const second = await resolveProjectIdBySlug(fake.client as any, 'demo', 'testnet');

    expect(first).toBe('project-1');
    expect(second).toBe('project-1');
    expect(fake.counts.projectLookups).toBe(1);
  });

  it('caches provider configs and reuses the project id lookup', async () => {
    const fake = createFakeSupabase();

    const first = await loadProjectProviderConfig(
      fake.client as any,
      'demo',
      'twelvedata',
      'testnet'
    );
    const second = await loadProjectProviderConfig(
      fake.client as any,
      'demo',
      'twelvedata',
      'testnet'
    );

    expect(first).toEqual({
      provider_id: 'twelvedata',
      enabled: true,
      config: { pair: 'NEO-USD' },
    });
    expect(second).toEqual(first);
    expect(fake.counts.projectLookups).toBe(1);
    expect(fake.counts.providerLookups).toBe(1);
  });
});
