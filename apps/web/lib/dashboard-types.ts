/**
 * Shared TypeScript types for the Morpheus dashboard view layer.
 *
 * These types are intentionally UI-centric: they describe the data shapes that
 * dashboard components consume, independent of the underlying API or on-chain
 * representation.
 */

/**
 * Public-key metadata returned by the protected runtime public-key endpoint.
 */
export interface OracleKeyMeta {
  public_key: string;
  algorithm?: string;
  key_source?: string;
}

/**
 * Parse an untyped public-key response body into a typed OracleKeyMeta.
 */
export function parseOracleKeyMeta(
  body: Record<string, unknown> | null | undefined
): OracleKeyMeta | null {
  if (!body || typeof body.public_key !== 'string') return null;
  return {
    public_key: body.public_key,
    algorithm: typeof body.algorithm === 'string' ? body.algorithm : undefined,
    key_source: typeof body.key_source === 'string' ? body.key_source : undefined,
  };
}

/**
 * Oracle registry state as returned by the on-chain state endpoint.
 */
export interface OracleState {
  contract?: string | null;
  domain?: string | null;
  request_fee_display?: string | null;
}

/**
 * A single price record stored on-chain.
 */
export interface OnchainRecord {
  pair: string;
  price_display: string;
  price_units: string;
  timestamp: string;
  timestamp_iso: string | null;
  attestation_hash: string;
}

/**
 * Raw on-chain state body returned by /api/onchain/state.
 */
export interface OnchainStateBody {
  network?: string;
  error?: string | null;
  neo_n3?: {
    oracle?: OracleState | null;
    datafeed?: {
      pair_count?: number;
      records?: OnchainRecord[];
      contract?: string;
      domain?: string;
    };
    error?: string | null;
  };
}

/**
 * Summary of a data provider as shown in the Data Catalog tab.
 */
export interface ProviderSummary {
  id: string;
  description?: string;
  supports?: string[];
  auth?: string;
}

/**
 * Network configuration derived for the dashboard from the global network config.
 */
export interface NetworkConfig {
  networkKey: string;
  label: string;
  name: string;
  networkMagic: number;
  oracleContract: string;
  datafeedContract: string;
  callbackConsumer: string;
  oracleDomain: string;
  datafeedDomain: string;
  oracleAttestationExplorerUrl: string;
  datafeedAttestationExplorerUrl: string;
}

/**
 * A generated request package produced by the Oracle or Compute tab.
 */
export interface GeneratedRequestPackage {
  requestType: string;
  payload: Record<string, unknown>;
  payloadJson: string;
  neoN3Snippet: string;
}

/**
 * Real-time market quote for a selected feed.
 */
export interface LiveQuote {
  price?: string | number;
  symbol?: string;
}

/**
 * TEE / dstack runtime metadata shown in the dashboard overview.
 */
export interface DstackInfo {
  app_id?: string;
  compose_hash?: string;
  client_kind?: string;
}

/**
 * Normalized result from a NEP-21 wallet invoke.
 */
export interface WalletSubmitResult {
  txid?: string;
}
