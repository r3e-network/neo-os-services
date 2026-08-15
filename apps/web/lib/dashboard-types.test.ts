import { describe, expect, it } from 'vitest';

import { getDashboardNetworkConfig } from '@/components/dashboard/networkSelection';
import { readOracleStateFromBody } from '@/components/dashboard/oracleReadiness';
import { parseOracleKeyMeta } from './dashboard-types';

describe('dashboard view-model helpers', () => {
  it('parseOracleKeyMeta returns a typed OracleKeyMeta from a valid response body', () => {
    const meta = parseOracleKeyMeta({
      public_key: '0x' + 'a'.repeat(64),
      algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
      key_source: 'nitro-attestation',
    });

    expect(meta).not.toBeNull();
    expect(meta?.public_key).toBe('0x' + 'a'.repeat(64));
    expect(meta?.algorithm).toBe('X25519-HKDF-SHA256-AES-256-GCM');
    expect(meta?.key_source).toBe('nitro-attestation');
  });

  it('parseOracleKeyMeta returns null when public_key is missing or invalid', () => {
    expect(parseOracleKeyMeta(null)).toBeNull();
    expect(parseOracleKeyMeta(undefined)).toBeNull();
    expect(parseOracleKeyMeta({})).toBeNull();
    expect(parseOracleKeyMeta({ public_key: 123 })).toBeNull();
  });

  it('readOracleStateFromBody returns a typed OracleState from an on-chain body', () => {
    const state = readOracleStateFromBody({
      network: 'testnet',
      neo_n3: {
        oracle: {
          contract: '0x1234567890abcdef1234567890abcdef12345678',
          domain: 'oracle.testnet.n3',
          request_fee_display: '0.01000000 GAS',
        },
      },
    });

    expect(state).toEqual({
      contract: '0x1234567890abcdef1234567890abcdef12345678',
      domain: 'oracle.testnet.n3',
      request_fee_display: '0.01000000 GAS',
    });
  });

  it('readOracleStateFromBody returns null for a missing oracle block', () => {
    expect(readOracleStateFromBody(null)).toBeNull();
    expect(readOracleStateFromBody({ network: 'testnet' })).toBeNull();
  });

  it('getDashboardNetworkConfig returns a fully typed NetworkConfig', () => {
    const config = getDashboardNetworkConfig('testnet');

    expect(typeof config.networkKey).toBe('string');
    expect(typeof config.label).toBe('string');
    expect(typeof config.name).toBe('string');
    expect(typeof config.networkMagic).toBe('number');
    expect(typeof config.oracleContract).toBe('string');
    expect(typeof config.datafeedContract).toBe('string');
    expect(typeof config.callbackConsumer).toBe('string');
    expect(typeof config.oracleDomain).toBe('string');
    expect(typeof config.datafeedDomain).toBe('string');
    expect(typeof config.oracleAttestationExplorerUrl).toBe('string');
    expect(typeof config.datafeedAttestationExplorerUrl).toBe('string');
  });
});
