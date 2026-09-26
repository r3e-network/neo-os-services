/**
 * A network label that names neither mainnet nor testnet. The resolvers that
 * refuse to map an unknown label to a network throw it, so a route can answer
 * the caller's mistake with 400 instead of an unhandled 500.
 */
export class UnsupportedNetworkError extends Error {
  readonly code = 'UNSUPPORTED_NETWORK';
  readonly label: string;

  constructor(label: string) {
    super(`unsupported Neo network: ${label}`);
    this.name = 'UnsupportedNetworkError';
    this.label = label;
  }
}

/**
 * Matches by `code` rather than `instanceof`, so the check holds even when the
 * error was thrown by another instance of this module (separate bundles, or a
 * test that resets its module registry).
 */
export function isUnsupportedNetworkError(error: unknown): error is UnsupportedNetworkError {
  return error instanceof Error && (error as { code?: unknown }).code === 'UNSUPPORTED_NETWORK';
}
