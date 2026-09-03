import { timingSafeCompare, trimString } from '@r3e-network/neo-os-services-shared/utils';

type ControlPlaneCredentialScope = 'control_plane' | 'workflow';

function matchesConfiguredCredential(request: Request, configured: Array<string | undefined>) {
  const candidates = [...new Set(configured.map((value) => trimString(value)).filter(Boolean))];
  if (candidates.length === 0) return false;
  const presented = [
    trimString(request.headers.get('x-admin-api-key')),
    trimString(request.headers.get('x-morpheus-workflow-key')),
  ];
  const bearer = trimString(request.headers.get('authorization'));
  if (bearer.toLowerCase().startsWith('bearer ')) {
    presented.push(trimString(bearer.slice(7)));
  }

  let matched = false;
  for (const expected of candidates) {
    for (const actual of presented) {
      if (timingSafeCompare(actual, expected)) matched = true;
    }
  }
  return matched;
}

function legacyRuntimeTokenCompatibilityEnabled() {
  if (process.env.NODE_ENV === 'production') return false;
  return /^(1|true|yes|on)$/i.test(
    trimString(
      process.env.MORPHEUS_CONTROL_PLANE_LEGACY_RUNTIME_TOKEN_COMPAT ||
        process.env.MORPHEUS_ALLOW_LEGACY_RUNTIME_CONTROL_PLANE
    )
  );
}

function runtimeDataPlaneCredentials() {
  return [
    process.env.MORPHEUS_RUNTIME_TOKEN,
    process.env.NITRO_API_TOKEN,
    process.env.NITRO_SHARED_SECRET,
  ]
    .map((value) => trimString(value))
    .filter(Boolean);
}

function controlPlaneCredentials(scope: ControlPlaneCredentialScope) {
  const scoped =
    scope === 'workflow'
      ? [
          process.env.MORPHEUS_WORKFLOW_API_KEY,
          process.env.MORPHEUS_APP_BACKEND_TOKEN,
          // An operator may perform a manual recovery, but the relayer
          // operations credential is intentionally not a workflow credential.
          process.env.MORPHEUS_OPERATOR_API_KEY,
        ]
      : [
          process.env.MORPHEUS_CONTROL_PLANE_API_KEY,
          process.env.MORPHEUS_OPERATOR_API_KEY,
          process.env.MORPHEUS_RELAYER_API_KEY,
          process.env.MORPHEUS_RELAYER_ADMIN_API_KEY,
          process.env.ADMIN_CONSOLE_API_KEY,
        ];
  const runtimeCredentials = new Set(runtimeDataPlaneCredentials());
  const independent = scoped.filter(
    (value) => trimString(value) && !runtimeCredentials.has(trimString(value))
  );
  if (legacyRuntimeTokenCompatibilityEnabled()) {
    independent.push(...runtimeDataPlaneCredentials());
  }
  return independent;
}

export function isAuthorizedControlPlaneRequest(request: Request) {
  return matchesConfiguredCredential(request, controlPlaneCredentials('control_plane'));
}

export function isAuthorizedWorkflowRequest(request: Request) {
  return matchesConfiguredCredential(request, controlPlaneCredentials('workflow'));
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
