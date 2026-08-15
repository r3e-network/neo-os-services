import { DEFAULT_FEED_SYMBOLS, getFeedDescriptor } from '@/lib/feed-defaults';

// Re-homed (2026-06): the feed catalog is the static, canonical symbol list
// (lib/feed-defaults.DEFAULT_FEED_SYMBOLS) — no runtime needed. Consumers
// (components/dashboard/ProvidersTab.tsx) read body.pairs.
export async function GET() {
  return Response.json(
    {
      pairs: [...DEFAULT_FEED_SYMBOLS],
      descriptors: DEFAULT_FEED_SYMBOLS.map((pair) => {
        const descriptor = getFeedDescriptor(pair);
        return { pair, ...(descriptor ? { descriptor } : {}) };
      }),
      generated_at: new Date().toISOString(),
      source: 'static-config',
    },
    { headers: { 'cache-control': 'public, max-age=300, stale-while-revalidate=600' } }
  );
}
