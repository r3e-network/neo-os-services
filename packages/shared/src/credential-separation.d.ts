export declare const PRODUCTION_CREDENTIAL_DOMAINS: Readonly<Record<string, readonly string[]>>;

export type CredentialDomainCollision = {
  domains: string[];
  names: string[];
};

export declare function findCredentialDomainCollisions(
  environment: Record<string, unknown> | NodeJS.ProcessEnv,
  domains?: Readonly<Record<string, readonly string[]>>
): CredentialDomainCollision[];

export declare function formatCredentialDomainCollisions(
  collisions: CredentialDomainCollision[]
): string;

export declare function assertCredentialDomainsDistinct(
  environment: Record<string, unknown> | NodeJS.ProcessEnv,
  options?: {
    domains?: Readonly<Record<string, readonly string[]>>;
    messagePrefix?: string;
  }
): void;
