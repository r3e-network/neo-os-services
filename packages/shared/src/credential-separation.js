import { trimString } from './utils.js';

// Aliases inside one domain may intentionally share a value. A value appearing
// in two distinct trust domains is a deployment error.
export const PRODUCTION_CREDENTIAL_DOMAINS = Object.freeze({
  runtime: ['MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN', 'NITRO_SHARED_SECRET'],
  workflow: ['MORPHEUS_WORKFLOW_API_KEY', 'MORPHEUS_APP_BACKEND_TOKEN'],
  operator: [
    'MORPHEUS_CONTROL_PLANE_API_KEY',
    'MORPHEUS_OPERATOR_API_KEY',
    'ADMIN_CONSOLE_API_KEY',
  ],
  relayer: ['MORPHEUS_RELAYER_API_KEY'],
  relayer_admin: ['MORPHEUS_RELAYER_ADMIN_API_KEY'],
  signing: ['MORPHEUS_SIGNING_ADMIN_API_KEY'],
  relay: ['MORPHEUS_RELAY_ADMIN_API_KEY'],
  custody: ['SIGNER_SERVICE_TOKEN'],
});

export function findCredentialDomainCollisions(
  environment,
  domains = PRODUCTION_CREDENTIAL_DOMAINS
) {
  const values = new Map();
  for (const [domain, names] of Object.entries(domains)) {
    for (const name of names) {
      const value = trimString(environment[name]);
      if (!value) continue;
      const entry = values.get(value) || [];
      entry.push({ domain, name });
      values.set(value, entry);
    }
  }

  return [...values.values()]
    .filter((uses) => new Set(uses.map(({ domain }) => domain)).size > 1)
    .map((uses) => ({
      domains: [...new Set(uses.map(({ domain }) => domain))].sort(),
      names: uses.map(({ name }) => name).sort(),
    }))
    .sort((left, right) => left.names.join(',').localeCompare(right.names.join(',')));
}

export function formatCredentialDomainCollisions(collisions) {
  return collisions.map(({ names }) => names.join(', ')).join('; ');
}

export function assertCredentialDomainsDistinct(environment, options = {}) {
  const collisions = findCredentialDomainCollisions(environment, options.domains);
  if (collisions.length === 0) return;
  const names = formatCredentialDomainCollisions(collisions);
  const prefix = options.messagePrefix || 'credentials must be pairwise distinct across trust domains';
  throw new Error(`${prefix}: ${names}`);
}
