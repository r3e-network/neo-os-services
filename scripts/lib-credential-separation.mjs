// Re-export the shared production credential domain table so deploy/env
// checkers and the runtime web/control-plane surfaces stay in lockstep.
export {
  PRODUCTION_CREDENTIAL_DOMAINS,
  assertCredentialDomainsDistinct,
  findCredentialDomainCollisions,
  formatCredentialDomainCollisions,
} from '@r3e-network/neo-os-services-shared/credential-separation';
