type Environment = Readonly<Record<string, string | undefined>>;

type SupabaseRateLimitConfig = {
  url: string;
  serviceKey: string;
};

function trimString(value: string | undefined): string {
  return String(value || '').trim();
}

export function resolveSupabaseRateLimitConfig(
  environment: Environment = process.env
): SupabaseRateLimitConfig | null {
  const url = trimString(
    environment.SUPABASE_URL ||
      environment.NEXT_PUBLIC_SUPABASE_URL ||
      environment.morpheus_SUPABASE_URL
  );
  const serviceKey = trimString(
    environment.SUPABASE_SECRET_KEY ||
      environment.SUPABASE_SERVICE_ROLE_KEY ||
      environment.morpheus_SUPABASE_SECRET_KEY ||
      environment.morpheus_SUPABASE_SERVICE_ROLE_KEY
  );
  if (!url || !serviceKey) return null;
  return {
    url: url.replace(/\/+$/, ''),
    serviceKey,
  };
}

export function isSupabaseRateLimitConfigured(environment: Environment = process.env): boolean {
  return Boolean(resolveSupabaseRateLimitConfig(environment));
}

export async function incrementSupabaseFixedWindowCounter(key: string, windowMs: number) {
  const config = resolveSupabaseRateLimitConfig();
  if (!config) {
    throw new Error('Supabase rate limiting is not configured');
  }

  const response = await fetch(`${config.url}/rest/v1/rpc/morpheus_consume_rate_limit`, {
    method: 'POST',
    headers: {
      apikey: config.serviceKey,
      authorization: `Bearer ${config.serviceKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      p_key: key,
      p_window_ms: Math.trunc(windowMs),
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Supabase rate-limit request failed (${response.status})`);
  }
  const row = Array.isArray(payload) ? payload[0] : payload;
  const current = Number(row?.current_count);
  const ttlMs = Number(row?.ttl_ms);
  if (!Number.isFinite(current) || current < 1 || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error('Supabase rate-limit response is invalid');
  }
  return { current, ttlMs };
}
