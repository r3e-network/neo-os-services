import { timingSafeCompare, trimString } from '@r3e-network/neo-os-services-shared/utils';
import { isAuthorizedAdminRequest } from './server-supabase';

export function isAuthorizedControlPlaneRequest(request: Request) {
  // provider_config is the LOW-privilege provider-management scope and must NOT
  // authorize control-plane execution — callback-broadcast fulfillment, feed-tick
  // signed updates, automation execution, or job reads (audit finding
  // 19/20/30/31/37). Only the operator/relayer/admin-console keys (relayer_ops
  // scope) and the MORPHEUS_* runtime token are accepted here.
  if (isAuthorizedAdminRequest(request, 'relayer_ops')) {
    return true;
  }

  // Only the current MORPHEUS_* runtime token is honored as a shared credential.
  const sharedToken = trimString(process.env.MORPHEUS_RUNTIME_TOKEN);
  if (!sharedToken) return false;
  const bearer = trimString(request.headers.get('authorization'));
  const admin = trimString(request.headers.get('x-admin-api-key'));
  return (
    timingSafeCompare(bearer, `Bearer ${sharedToken}`) || timingSafeCompare(admin, sharedToken)
  );
}

function extractRuntimeAuthToken(request: Request) {
  const authorization = trimString(request.headers.get('authorization'));
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return trimString(authorization.slice(7));
  }
  return (
    trimString(request.headers.get('x-morpheus-runtime-token')) ||
    trimString(request.headers.get('x-nitro-token')) ||
    trimString(request.headers.get('x-api-key'))
  );
}

// Trusted runtime credential check for apps/web routes that proxy to the Nitro
// runtime (e.g. /api/runtime/keys/derived). The edge gateway already requires a
// trusted token for the same upstream paths; mirroring it here closes the gap
// where the apps/web origin honored those paths unauthenticated.
export function isAuthorizedRuntimeRequest(request: Request) {
  const token = extractRuntimeAuthToken(request);
  if (!token) return false;
  const trustedTokens = [
    process.env.MORPHEUS_RUNTIME_TOKEN,
    process.env.NITRO_API_TOKEN,
    process.env.NITRO_SHARED_SECRET,
  ]
    .map((value) => trimString(value))
    .filter(Boolean);
  if (trustedTokens.length === 0) return false;
  // Walk the full list with a constant-time compare so response timing cannot be
  // used to recover a configured token byte-by-byte.
  let matched = false;
  for (const candidate of trustedTokens) {
    if (timingSafeCompare(token, candidate)) matched = true;
  }
  return matched;
}
