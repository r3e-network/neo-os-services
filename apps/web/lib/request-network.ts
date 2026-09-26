import { badRequest } from './api-helpers';
import { isUnsupportedNetworkError } from './network-errors';
import { resolveSupabaseNetwork, type MorpheusNetwork } from './server-supabase';

export type RequestNetwork =
  | { ok: true; network: MorpheusNetwork }
  | { ok: false; response: Response; error: string };

/**
 * Resolve a network label that came from a request (query string, body or
 * header) with resolveSupabaseNetwork. An absent value keeps that resolver's
 * deployment default. A label that is neither mainnet nor testnet is the
 * caller's error: it answers 400 `{ error, error_code: 'UNSUPPORTED_NETWORK' }`
 * and is never mapped to another network. Any other failure (an invalid
 * deployment MORPHEUS_NETWORK, for one) is a server fault and still throws.
 */
export function resolveRequestNetwork(value?: string | null): RequestNetwork {
  try {
    return { ok: true, network: resolveSupabaseNetwork(value) };
  } catch (error) {
    if (isUnsupportedNetworkError(error) && String(value ?? '').trim()) {
      return {
        ok: false,
        response: badRequest(error.message, 400, error.code),
        error: error.message,
      };
    }
    throw error;
  }
}
