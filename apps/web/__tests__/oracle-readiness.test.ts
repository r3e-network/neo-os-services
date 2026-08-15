import { describe, expect, it } from 'vitest';

import {
  derivePackageReadiness,
  evaluateOracleKeyStatus,
  evaluateOracleStateStatus,
  readOracleStateFromBody,
} from '../components/dashboard/oracleReadiness';

describe('oracle readiness helpers', () => {
  it('marks degraded on-chain state as blocked for wallet submission', () => {
    const body = {
      network: 'testnet',
      neo_n3: {
        oracle: null,
        error: 'rpc unavailable',
      },
    };

    const stateStatus = evaluateOracleStateStatus({
      responseOk: true,
      responseStatus: 200,
      body,
      selectedNetworkName: 'Neo N3 Testnet',
    });
    const readiness = derivePackageReadiness({
      oracleSubmitReady: false,
      oracleStateStatus: stateStatus,
    });

    expect(readOracleStateFromBody(body)).toBeNull();
    expect(stateStatus).toMatchObject({
      level: 'blocked',
      label: 'On-chain state unavailable',
      detail: 'rpc unavailable',
    });
    expect(readiness).toMatchObject({
      label: 'NEEDS VERIFICATION',
      tone: 'warning',
    });
  });

  it('marks missing oracle contract state as warning and not wallet-ready', () => {
    const body = {
      network: 'testnet',
      neo_n3: {
        oracle: null,
        error: null,
      },
    };

    const stateStatus = evaluateOracleStateStatus({
      responseOk: true,
      responseStatus: 200,
      body,
      selectedNetworkName: 'Neo N3 Testnet',
    });
    const readiness = derivePackageReadiness({
      oracleSubmitReady: false,
      oracleStateStatus: stateStatus,
    });

    expect(stateStatus).toMatchObject({
      level: 'warning',
      label: 'Oracle contract unverified',
    });
    expect(readiness.label).toBe('NEEDS VERIFICATION');
  });

  it('surfaces degraded public-key state while preserving public payload readiness', () => {
    const body = {
      available: false,
      degraded: true,
      public_key: null,
      message: 'runtime denied public-key access',
    };

    const stateStatus = evaluateOracleStateStatus({
      responseOk: true,
      responseStatus: 200,
      body: {
        network: 'testnet',
        neo_n3: {
          oracle: {
            contract: '0x1234567890abcdef1234567890abcdef12345678',
            request_fee_display: '0.01000000 GAS',
          },
          error: null,
        },
      },
      selectedNetworkName: 'Neo N3 Testnet',
    });
    const keyStatus = evaluateOracleKeyStatus({
      responseOk: true,
      responseStatus: 200,
      body,
    });
    const readiness = derivePackageReadiness({
      oracleSubmitReady: true,
      protectedKeyReady: false,
      oracleStateStatus: stateStatus,
      oracleKeyStatus: keyStatus,
    });

    expect(keyStatus).toMatchObject({
      level: 'blocked',
      label: 'Public key unavailable',
      detail: 'runtime denied public-key access',
    });
    expect(readiness).toMatchObject({
      label: 'PUBLIC PAYLOAD READY',
      tone: 'warning',
    });
    expect(readiness.detail).toContain('encrypted params remain disabled');
  });
});
