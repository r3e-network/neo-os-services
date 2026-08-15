import type { OnchainStateBody, OracleState } from '@/lib/dashboard-types';

export type ReadinessLevel = 'loading' | 'ready' | 'warning' | 'blocked';

export type RuntimeStatus = {
  level: ReadinessLevel;
  label: string;
  detail: string;
};

export const ORACLE_KEY_LOADING_STATUS: RuntimeStatus = {
  level: 'loading',
  label: 'Public key loading',
  detail: 'Checking protected runtime access for local encryption.',
};

export const ORACLE_STATE_LOADING_STATUS: RuntimeStatus = {
  level: 'loading',
  label: 'Oracle state loading',
  detail: 'Checking the selected network contract, fee, and on-chain state.',
};

export function buildNetworkQueryPart(networkKey?: string | null, separator: '?' | '&' = '?') {
  return networkKey ? `${separator}network=${encodeURIComponent(networkKey)}` : '';
}

export function readOracleStateFromBody(
  body: OnchainStateBody | null | undefined
): OracleState | null {
  return body?.neo_n3?.oracle || null;
}

export function evaluateOracleKeyStatus(args: {
  responseOk: boolean;
  responseStatus: number;
  body: Record<string, unknown>;
}): RuntimeStatus {
  const { responseOk, responseStatus, body } = args;
  if (responseOk && body?.public_key) {
    return {
      level: 'ready',
      label: 'Public key available',
      detail: body?.key_source
        ? `Encryption key served by ${body.key_source}.`
        : 'Encryption key is available for local sealing.',
    };
  }

  return {
    level: 'blocked',
    label: 'Public key unavailable',
    detail:
      (typeof body?.message === 'string' && body.message) ||
      (typeof body?.error === 'string' && body.error) ||
      `Runtime public key request returned ${responseStatus}. Encryption is disabled until protected runtime access is available.`,
  };
}

export function evaluateOracleStateStatus(args: {
  responseOk: boolean;
  responseStatus: number;
  body: OnchainStateBody | null | undefined;
  selectedNetworkName: string;
}): RuntimeStatus {
  const { responseOk, responseStatus, body, selectedNetworkName } = args;
  const nextOracleState = readOracleStateFromBody(body);

  if (!responseOk || body?.neo_n3?.error) {
    return {
      level: 'blocked',
      label: 'On-chain state unavailable',
      detail:
        body?.neo_n3?.error ||
        body?.error ||
        `State endpoint returned ${responseStatus}. Wallet submission is disabled until the selected network is verified.`,
    };
  }

  if (!nextOracleState?.contract) {
    return {
      level: 'warning',
      label: 'Oracle contract unverified',
      detail:
        'The selected network state did not return an Oracle contract. Package generation remains available, but NEP-21 submission is disabled.',
    };
  }

  return {
    level: 'ready',
    label: 'On-chain state verified',
    detail: `Oracle contract ${nextOracleState.contract} and request fee are loaded for ${selectedNetworkName}.`,
  };
}

export function derivePackageReadiness(args: {
  oracleSubmitReady: boolean;
  protectedKeyReady?: boolean;
  oracleStateStatus: RuntimeStatus;
  oracleKeyStatus?: RuntimeStatus;
}) {
  const { oracleSubmitReady, protectedKeyReady = true, oracleStateStatus, oracleKeyStatus } = args;

  if (!oracleSubmitReady) {
    return {
      label: 'NEEDS VERIFICATION',
      detail: oracleStateStatus.detail,
      tone: 'warning' as const,
    };
  }

  if (!protectedKeyReady && oracleKeyStatus) {
    return {
      label: 'PUBLIC PAYLOAD READY',
      detail: `${oracleStateStatus.detail} Public payload submission is available, but encrypted params remain disabled until protected runtime public-key access is restored: ${oracleKeyStatus.detail}`,
      tone: 'warning' as const,
    };
  }

  return {
    label: 'WALLET READY',
    detail: oracleStateStatus.detail,
    tone: 'success' as const,
  };
}

export function getReadinessAccent(statuses: RuntimeStatus[], readyAccent = 'var(--neo-green)') {
  if (statuses.some((status) => status.level === 'blocked')) return 'var(--warning)';
  if (statuses.some((status) => status.level === 'warning')) return 'var(--warning)';
  if (statuses.some((status) => status.level === 'loading')) return 'var(--accent-blue)';
  return readyAccent;
}
