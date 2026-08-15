import { trimString } from '@r3e-network/neo-os-services-shared/utils';

function getSupabaseConfig(env) {
  const baseUrl = trimString(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '');
  const apiKey = trimString(
    env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || ''
  );
  if (!baseUrl || !apiKey) throw new Error('SUPABASE_URL and service-role key are required');
  return {
    restUrl: `${baseUrl.replace(/\/$/, '')}/rest/v1`,
    apiKey,
  };
}

async function supabaseFetch(env, path, init = {}) {
  const config = getSupabaseConfig(env);
  const headers = new Headers(init.headers || {});
  headers.set('apikey', config.apiKey);
  headers.set('authorization', `Bearer ${config.apiKey}`);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return fetch(`${config.restUrl}${path}`, {
    ...init,
    headers,
  });
}

export { supabaseFetch, getSupabaseConfig };
