export type UpstashRedisConfig = {
  url: string;
  token: string;
  source: 'upstash' | 'vercel-kv';
};

type Environment = Readonly<Record<string, string | undefined>>;

const CONFIG_PAIRS = [
  {
    source: 'upstash' as const,
    url: 'UPSTASH_REDIS_REST_URL',
    token: 'UPSTASH_REDIS_REST_TOKEN',
  },
  {
    source: 'vercel-kv' as const,
    url: 'KV_REST_API_URL',
    token: 'KV_REST_API_TOKEN',
  },
];

function trimString(value: string | undefined): string {
  return String(value || '').trim();
}

/**
 * Resolve one complete Redis credential pair without mixing values from
 * different providers. Native Upstash variables take precedence so existing
 * Cloudflare, Nitro, and local deployments retain their current behavior.
 */
export function resolveUpstashRedisConfig(
  environment: Environment = process.env
): UpstashRedisConfig | null {
  for (const pair of CONFIG_PAIRS) {
    const url = trimString(environment[pair.url]);
    const token = trimString(environment[pair.token]);
    if (url && token) {
      return {
        url: url.replace(/\/+$/, ''),
        token,
        source: pair.source,
      };
    }
  }
  return null;
}

export function isUpstashRedisConfigured(environment: Environment = process.env): boolean {
  return Boolean(resolveUpstashRedisConfig(environment));
}
