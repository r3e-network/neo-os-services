/**
 * Node-only runtime helpers shared by the workers (nitro-worker and
 * morpheus-relayer). Kept out of utils.js so Cloudflare Worker consumers of
 * `@r3e-network/neo-os-services-shared/utils` never pull in node:crypto or process.env.
 */

/**
 * Resolve the first non-empty value among the given env-var names, checking
 * `process.env` first and the cached `MORPHEUS_RUNTIME_CONFIG_JSON` document as
 * a fallback for each name in turn. Returns '' when none are set.
 */
export function env(...names: string[]): string;

/**
 * Normalize the supported input shapes (Buffer, Uint8Array, ArrayBuffer,
 * string, or arbitrary value via stableStringify) into a Node Buffer.
 */
export function ensureBuffer(input: Buffer | Uint8Array | ArrayBuffer | string | unknown): Buffer;

/**
 * SHA-256 hex digest of the given input, normalized through `ensureBuffer`.
 */
export function sha256Hex(input: Buffer | Uint8Array | ArrayBuffer | string | unknown): string;

/**
 * SECURITY (S4): canonical message for a manual relayer action (retry/replay).
 * The event is serialized deterministically (sorted keys) so the same object
 * verifies identically after a jsonb round-trip through Postgres.
 */
export function manualActionCanonical(
  action: string,
  network: string,
  eventKey: string,
  event: unknown
): string;

/**
 * HMAC-SHA256 hex signature over `manualActionCanonical(...)`. Callers supply
 * the shared MORPHEUS_MANUAL_ACTION_HMAC_SECRET.
 */
export function signManualAction(
  secret: string,
  action: string,
  network: string,
  eventKey: string,
  event: unknown
): string;

/**
 * Constant-time verification of an HMAC signature over a manual action.
 * A non-hex or wrong-length signature fails closed (returns false).
 */
export function verifyManualActionSignature(
  secret: string,
  action: string,
  network: string,
  eventKey: string,
  event: unknown,
  signature: string
): boolean;
