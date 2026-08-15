'use client';

import type { OracleKeyMeta } from '@/lib/dashboard-types';
import { OracleEncryptionPanel } from './OracleEncryptionPanel';
import { OracleRequestShape } from './OracleRequestShape';

interface OracleRequestFormProps {
  oracleConfidentialJson: string;
  setOracleConfidentialJson: (value: string) => void;
  keySummary: { algorithm: string; source: string };
  isEncrypting: boolean;
  oracleKeyMeta: OracleKeyMeta | null;
  oracleEncryptedParams: string;
  setOracleEncryptedParams: (value: string) => void;
  onEncryptPatch: () => void;
  requestMode: string;
  setRequestMode: (value: string) => void;
  oracleTargetChain: string;
  setOracleTargetChain: (value: string) => void;
  providerSymbol: string;
  setProviderSymbol: (value: string) => void;
  oracleUrl: string;
  setOracleUrl: (value: string) => void;
  httpMethod: string;
  setHttpMethod: (value: string) => void;
  oracleJsonPath: string;
  setOracleJsonPath: (value: string) => void;
  walletCallbackHash: string;
  setWalletCallbackHash: (value: string) => void;
  walletCallbackMethod: string;
  setWalletCallbackMethod: (value: string) => void;
  useCustomScript: boolean;
  setUseCustomScript: (value: boolean) => void;
  oracleScript: string;
  setOracleScript: (value: string) => void;
  oracleScriptRefJson: string;
  setOracleScriptRefJson: (value: string) => void;
  onGeneratePackage: () => void;
}

export function OracleRequestForm({
  oracleConfidentialJson,
  setOracleConfidentialJson,
  keySummary,
  isEncrypting,
  oracleKeyMeta,
  oracleEncryptedParams,
  setOracleEncryptedParams,
  onEncryptPatch,
  requestMode,
  setRequestMode,
  oracleTargetChain,
  setOracleTargetChain,
  providerSymbol,
  setProviderSymbol,
  oracleUrl,
  setOracleUrl,
  httpMethod,
  setHttpMethod,
  oracleJsonPath,
  setOracleJsonPath,
  walletCallbackHash,
  setWalletCallbackHash,
  walletCallbackMethod,
  setWalletCallbackMethod,
  useCustomScript,
  setUseCustomScript,
  oracleScript,
  setOracleScript,
  oracleScriptRefJson,
  setOracleScriptRefJson,
  onGeneratePackage,
}: OracleRequestFormProps) {
  return (
    <div className="grid grid-2" style={{ alignItems: 'start', gap: '2rem' }}>
      <OracleEncryptionPanel
        oracleConfidentialJson={oracleConfidentialJson}
        setOracleConfidentialJson={setOracleConfidentialJson}
        keySummary={keySummary}
        isEncrypting={isEncrypting}
        oracleKeyMeta={oracleKeyMeta}
        oracleEncryptedParams={oracleEncryptedParams}
        setOracleEncryptedParams={setOracleEncryptedParams}
        onEncryptPatch={onEncryptPatch}
      />

      <OracleRequestShape
        requestMode={requestMode}
        setRequestMode={setRequestMode}
        oracleTargetChain={oracleTargetChain}
        setOracleTargetChain={setOracleTargetChain}
        providerSymbol={providerSymbol}
        setProviderSymbol={setProviderSymbol}
        oracleUrl={oracleUrl}
        setOracleUrl={setOracleUrl}
        httpMethod={httpMethod}
        setHttpMethod={setHttpMethod}
        oracleJsonPath={oracleJsonPath}
        setOracleJsonPath={setOracleJsonPath}
        walletCallbackHash={walletCallbackHash}
        setWalletCallbackHash={setWalletCallbackHash}
        walletCallbackMethod={walletCallbackMethod}
        setWalletCallbackMethod={setWalletCallbackMethod}
        useCustomScript={useCustomScript}
        setUseCustomScript={setUseCustomScript}
        oracleScript={oracleScript}
        setOracleScript={setOracleScript}
        oracleScriptRefJson={oracleScriptRefJson}
        setOracleScriptRefJson={setOracleScriptRefJson}
        onGeneratePackage={onGeneratePackage}
      />
    </div>
  );
}
