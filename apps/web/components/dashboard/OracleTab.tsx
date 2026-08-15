'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  GeneratedRequestPackage,
  OnchainStateBody,
  OracleKeyMeta,
  OracleState,
  ProviderSummary,
  WalletSubmitResult,
} from '@/lib/dashboard-types';
import { parseOracleKeyMeta } from '@/lib/dashboard-types';
import { encryptJsonWithOraclePublicKey } from '@/lib/browser-encryption';
import { invokeMorpheusOracleRequest } from '@/lib/nep21';
import {
  buildCallbackQueryTemplate,
  buildNeoRequestContractCall,
  buildNeoRequestInvoke,
  copyText,
  encodeUtf8Base64,
} from '@/lib/neo-snippets';

import { OracleSettings } from './OracleSettings';
import { OracleRequestForm } from './OracleRequestForm';
import { OracleResponseViewer } from './OracleResponseViewer';
import { getDashboardNetworkConfig } from './networkSelection';
import {
  ORACLE_KEY_LOADING_STATUS,
  ORACLE_STATE_LOADING_STATUS,
  derivePackageReadiness,
  evaluateOracleKeyStatus,
  evaluateOracleStateStatus,
  getReadinessAccent,
  readOracleStateFromBody,
  type RuntimeStatus,
} from './oracleReadiness';

interface OracleTabProps {
  providers: ProviderSummary[];
  setOutput: (output: string) => void;
}

function getSelectedNetworkQueryPart(separator: '?' | '&' = '?') {
  if (typeof window === 'undefined') return '';
  const network = new URL(window.location.href).searchParams.get('network');
  return network ? `${separator}network=${encodeURIComponent(network)}` : '';
}

export function OracleTab({ providers: _providers, setOutput }: OracleTabProps) {
  const initialNetworkConfig = getDashboardNetworkConfig();
  const [selectedNetworkKey, setSelectedNetworkKey] = useState(initialNetworkConfig.networkKey);
  const selectedNetworkConfig = useMemo(
    () => getDashboardNetworkConfig(selectedNetworkKey),
    [selectedNetworkKey]
  );
  const defaultCallbackHash = selectedNetworkConfig.callbackConsumer;
  const [requestMode, setRequestMode] = useState('provider');
  const [oracleUrl, setOracleUrl] = useState('');
  const [providerSymbol, setProviderSymbol] = useState('TWELVEDATA:NEO-USD');
  const [httpMethod, setHttpMethod] = useState('GET');
  const [oracleEncryptedParams, setOracleEncryptedParams] = useState('');
  const [oracleConfidentialJson, setOracleConfidentialJson] = useState('{}');
  const [oracleScript, setOracleScript] = useState('');
  const [oracleScriptRefJson, setOracleScriptRefJson] = useState('');
  const [oracleJsonPath, setOracleJsonPath] = useState('');
  const [useCustomScript, setUseCustomScript] = useState(false);
  const [oracleTargetChain, setOracleTargetChain] = useState('neo_n3');
  const [walletCallbackHash, setWalletCallbackHash] = useState(
    initialNetworkConfig.callbackConsumer
  );
  const [walletCallbackMethod, setWalletCallbackMethod] = useState('onOracleResult');
  const [oracleKeyMeta, setOracleKeyMeta] = useState<OracleKeyMeta | null>(null);
  const [oracleState, setOracleState] = useState<OracleState | null>(null);
  const [oracleKeyStatus, setOracleKeyStatus] = useState<RuntimeStatus>(ORACLE_KEY_LOADING_STATUS);
  const [oracleStateStatus, setOracleStateStatus] = useState<RuntimeStatus>(
    ORACLE_STATE_LOADING_STATUS
  );
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [generatedRequest, setGeneratedRequest] = useState<GeneratedRequestPackage | null>(null);
  const [copiedItem, setCopiedItem] = useState<string | null>(null);
  const [isWalletSubmitting, setIsWalletSubmitting] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const browserNetworkConfig = getDashboardNetworkConfig();
    setSelectedNetworkKey(browserNetworkConfig.networkKey);
    setWalletCallbackHash(browserNetworkConfig.callbackConsumer);
    void loadOracleKey();
    void loadOracleState();
  }, []);

  useEffect(() => {
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    };
  }, []);

  useEffect(() => {
    if (requestMode === 'provider') {
      setOracleUrl('');
      setHttpMethod('GET');
      setOracleJsonPath('price');
      if (useCustomScript) {
        setOracleScript(
          'function process(data, context, helpers) {\n return Number(data.price) > 0;\n}'
        );
      }
      if (!oracleEncryptedParams.trim()) {
        setOracleConfidentialJson('{\n "json_path": "price"\n}');
      }
      return;
    }

    setOracleUrl('');
    setHttpMethod('GET');
    setOracleJsonPath('');
    if (useCustomScript) {
      setOracleScript('');
    }
    if (!oracleEncryptedParams.trim()) {
      setOracleConfidentialJson('{\n "headers": {},\n "json_path": ""\n}');
    }
  }, [oracleEncryptedParams, requestMode, useCustomScript]);

  function applyOraclePreset(
    preset: 'public_quote' | 'private_api' | 'boolean_check' | 'hidden_builtin'
  ) {
    if (preset === 'public_quote') {
      setRequestMode('provider');
      setProviderSymbol('TWELVEDATA:NEO-USD');
      setOracleJsonPath('price');
      setOracleTargetChain('neo_n3');
      setUseCustomScript(false);
      setOracleEncryptedParams('');
      setOracleConfidentialJson('{\n "json_path": "price"\n}');
      setOutput(
        `>> Loaded preset: Public Quote\n>> Built-in provider quote request for ${selectedNetworkConfig.name}.`
      );
      return;
    }

    if (preset === 'private_api') {
      setRequestMode('url');
      setOracleUrl('');
      setHttpMethod('GET');
      setOracleJsonPath('');
      setOracleTargetChain('neo_n3');
      setUseCustomScript(false);
      setOracleEncryptedParams('');
      setOracleConfidentialJson('{\n "headers": {},\n "json_path": ""\n}');
      setOutput(
        '>> Loaded preset: Private API\n>> Encrypt the confidential JSON patch locally before submitting.'
      );
      return;
    }

    if (preset === 'boolean_check') {
      const nextScript = '';
      setRequestMode('url');
      setOracleUrl('');
      setHttpMethod('GET');
      setOracleJsonPath('');
      setOracleTargetChain('neo_n3');
      setUseCustomScript(true);
      setOracleScript(nextScript);
      setOracleEncryptedParams('');
      setOracleConfidentialJson(
        '{\n "headers": {},\n "json_path": "",\n "script": "",\n "entry_point": "process"\n}'
      );
      setOutput(
        '>> Loaded preset: Boolean Check\n>> This pattern returns only a boolean to the callback.'
      );
      return;
    }

    setRequestMode('provider');
    setProviderSymbol('TWELVEDATA:BTC-USD');
    setOracleJsonPath('price');
    setOracleTargetChain('neo_n3');
    setUseCustomScript(false);
    setOracleEncryptedParams('');
    setOracleConfidentialJson('{\n "json_path": "price",\n "target_chain": "neo_n3"\n}');
    setOutput(
      '>> Loaded preset: Hidden Built-in Params\n>> Encrypt the patch so helper fields stay private.'
    );
  }

  async function loadOracleKey() {
    setOracleKeyStatus(ORACLE_KEY_LOADING_STATUS);
    try {
      const response = await fetch(`/api/oracle/public-key${getSelectedNetworkQueryPart('?')}`);
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const meta = parseOracleKeyMeta(body);
      setOracleKeyMeta(meta);
      setOracleKeyStatus(
        evaluateOracleKeyStatus({
          responseOk: response.ok,
          responseStatus: response.status,
          body,
        })
      );
    } catch (err) {
      console.error('Failed to load oracle public key', err);
      setOracleKeyMeta(null);
      setOracleKeyStatus({
        level: 'blocked',
        label: 'Public key unavailable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function loadOracleState() {
    setOracleStateStatus(ORACLE_STATE_LOADING_STATUS);
    try {
      const response = await fetch(
        `/api/onchain/state?limit=20${getSelectedNetworkQueryPart('&')}`
      );
      const body = (await response.json().catch(() => ({}))) as OnchainStateBody;
      setSelectedNetworkKey(getDashboardNetworkConfig(body?.network).networkKey);
      const nextOracleState = readOracleStateFromBody(body);
      setOracleState(nextOracleState);
      setOracleStateStatus(
        evaluateOracleStateStatus({
          responseOk: response.ok,
          responseStatus: response.status,
          body,
          selectedNetworkName: getDashboardNetworkConfig(body?.network).name,
        })
      );
    } catch (err) {
      console.error('Failed to load on-chain oracle state', err);
      setOracleState(null);
      setOracleStateStatus({
        level: 'blocked',
        label: 'On-chain state unavailable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function encryptConfidentialPatch() {
    setIsEncrypting(true);
    try {
      let keyMeta: OracleKeyMeta | null = oracleKeyMeta?.public_key ? oracleKeyMeta : null;
      if (!keyMeta) {
        const response = await fetch(`/api/oracle/public-key${getSelectedNetworkQueryPart('?')}`);
        const body = (await response.json()) as Record<string, unknown>;
        keyMeta = parseOracleKeyMeta(body);
        setOracleKeyMeta(keyMeta);
        if (!keyMeta) {
          setOracleKeyStatus({
            level: 'blocked',
            label: 'Public key unavailable',
            detail:
              (typeof body.message === 'string' && body.message) ||
              (typeof body.error === 'string' && body.error) ||
              `Runtime public key request returned ${response.status}. Encryption is disabled until protected runtime access is available.`,
          });
          throw new Error('Public key not available');
        }
      }

      const ciphertext = await encryptJsonWithOraclePublicKey(
        keyMeta.public_key,
        oracleConfidentialJson
      );
      setOracleEncryptedParams(ciphertext);
      setOutput(
        '>> Confidential patch encrypted locally.\n>> Submit the generated payload through the on-chain Oracle contract.\n>> No live worker execution was triggered by this page.'
      );
    } catch (err: unknown) {
      setOutput(`!! Encryption Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsEncrypting(false);
    }
  }

  function buildOraclePayload() {
    const payload: Record<string, unknown> = {
      target_chain: oracleTargetChain,
    };

    if (requestMode === 'provider') {
      payload.symbol = providerSymbol;
    } else {
      payload.url = oracleUrl;
      if ((httpMethod || 'GET').toUpperCase() !== 'GET') {
        payload.method = httpMethod.toUpperCase();
      }
    }

    if (oracleJsonPath.trim()) {
      payload.json_path = oracleJsonPath.trim();
    }
    if (useCustomScript && oracleScript.trim()) {
      try {
        const parsedScriptRef = oracleScriptRefJson.trim() ? JSON.parse(oracleScriptRefJson) : null;
        if (parsedScriptRef && typeof parsedScriptRef === 'object') {
          payload.script_ref = parsedScriptRef;
        } else {
          payload.script = oracleScript.trim();
        }
      } catch {
        payload.script = oracleScript.trim();
      }
    }
    if (oracleEncryptedParams.trim()) {
      payload.encrypted_params = oracleEncryptedParams.trim();
    }

    return payload;
  }

  function generateOnchainPackage() {
    const requestType = requestMode === 'provider' ? 'privacy_oracle' : 'oracle';
    const payload = buildOraclePayload();
    const payloadJson = JSON.stringify(payload);

    const neoN3Snippet = buildNeoRequestContractCall({
      requestType,
      compactPayloadJson: payloadJson,
    });

    setGeneratedRequest({
      requestType,
      payload,
      payloadJson,
      neoN3Snippet,
    });

    setOutput(
      [
        '>> Oracle request package generated.',
        `>> Request type: ${requestType}`,
        `>> Oracle readiness: ${oracleStateStatus.label}`,
        `>> Neo N3 request fee: ${oracleState?.request_fee_display || 'unverified'}`,
        `>> Oracle contract: ${oracleState?.contract || selectedNetworkConfig.oracleContract}`,
        '>> Submit this payload through the on-chain Oracle contract. Do not call /oracle/smart-fetch directly from user flows.',
        '',
        payloadJson,
      ].join('\n')
    );
  }

  async function handleCopy(id: string, value: string) {
    try {
      await copyText(value);
      setCopiedItem(id);
    } catch {
      setOutput('Copy failed. Check browser clipboard permissions and try again.');
    }
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopiedItem(null), 1500);
  }

  async function submitGeneratedWithWallet() {
    if (!generatedRequest) return;
    if (!oracleSubmitReady) {
      setOutput(`!! NEP-21 wallet submit blocked: ${oracleStateStatus.detail}`);
      return;
    }
    if (Boolean(generatedRequest.payload?.encrypted_params) && oracleKeyStatus.level !== 'ready') {
      setOutput(`!! NEP-21 wallet submit blocked: ${oracleKeyStatus.detail}`);
      return;
    }
    setIsWalletSubmitting(true);
    setOutput('>> Waiting for NEP-21 wallet approval...');
    try {
      const result = (await invokeMorpheusOracleRequest({
        oracleHash: oracleState?.contract || selectedNetworkConfig.oracleContract,
        requestType: generatedRequest.requestType,
        payloadBase64,
        callbackHash: walletCallbackHash,
        callbackMethod: walletCallbackMethod,
        expectedNetworkMagic: selectedNetworkConfig.networkMagic,
        expectedNetworkLabel: selectedNetworkConfig.name,
      })) as WalletSubmitResult;
      setOutput(
        [
          '>> NEP-21 wallet submitted Oracle request.',
          `>> Transaction: ${result.txid || JSON.stringify(result)}`,
          '>> Read the emitted requestId, then query the callback readback template.',
        ].join('\n')
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setOutput(`!! NEP-21 wallet submit failed: ${message}`);
    } finally {
      setIsWalletSubmitting(false);
    }
  }

  const keySummary = useMemo(
    () => ({
      algorithm: oracleKeyMeta?.algorithm || 'X25519-HKDF-SHA256-AES-256-GCM',
      source: oracleKeyMeta?.key_source || 'unknown',
    }),
    [oracleKeyMeta]
  );

  const oracleSubmitReady = oracleStateStatus.level === 'ready' && Boolean(oracleState?.contract);
  const protectedKeyReady = oracleKeyStatus.level === 'ready';
  // A payload that carries encrypted_params depends on the protected runtime
  // public key. If that runtime is unavailable, the sealed params cannot be
  // honored, so wallet submission must be blocked even when on-chain state is ready.
  const payloadNeedsProtectedRuntime = Boolean(generatedRequest?.payload?.encrypted_params);
  const walletSubmitReady =
    oracleSubmitReady && (!payloadNeedsProtectedRuntime || protectedKeyReady);
  const packageReadiness = derivePackageReadiness({
    oracleSubmitReady,
    protectedKeyReady,
    oracleStateStatus,
    oracleKeyStatus,
  });
  const oracleStatusAccent =
    oracleStateStatus.level === 'ready'
      ? 'var(--neo-green)'
      : oracleStateStatus.level === 'loading'
        ? 'var(--accent-blue)'
        : 'var(--warning)';
  const readinessMessages = [oracleStateStatus, oracleKeyStatus].filter(
    (status) => status.level !== 'ready'
  );
  const readinessAccent = getReadinessAccent(readinessMessages, oracleStatusAccent);

  const payloadBase64 = generatedRequest ? encodeUtf8Base64(generatedRequest.payloadJson) : '';
  const neoRpcInvoke = generatedRequest
    ? buildNeoRequestInvoke({
        oracleContract: oracleState?.contract || selectedNetworkConfig.oracleContract,
        requestType: generatedRequest.requestType,
        payloadBase64,
        callbackHash: walletCallbackHash,
        callbackMethod: walletCallbackMethod,
      })
    : '';
  const callbackQueryTemplate = buildCallbackQueryTemplate(walletCallbackHash);

  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          borderBottom: '1px solid var(--border-dim)',
          paddingBottom: '1rem',
        }}
      >
        <div>
          <h2
            style={{
              fontSize: '2rem',
              fontWeight: 900,
              letterSpacing: 0,
              marginBottom: '0.5rem',
            }}
          >
            Oracle Requests
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            Seal confidential fields locally, then generate the exact on-chain request payload and
            callback snippets for Neo N3 submission.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontSize: '0.65rem',
              color: 'var(--text-secondary)',
              fontWeight: 800,
              fontFamily: 'var(--font-mono)',
            }}
          >
            ORACLE STATUS
          </div>
          <div
            style={{
              fontSize: '0.8rem',
              color: oracleStatusAccent,
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {oracleSubmitReady
              ? oracleState?.request_fee_display || '0.01 GAS'
              : oracleStateStatus.label}
          </div>
        </div>
      </div>

      {readinessMessages.length > 0 && (
        <div
          className="card-industrial"
          style={{ padding: '1.25rem 1.5rem', borderLeft: `4px solid ${readinessAccent}` }}
        >
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {readinessMessages.map((status) => (
              <p
                key={status.label}
                style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}
              >
                <strong style={{ color: 'var(--text-primary)' }}>{status.label}:</strong>{' '}
                {status.detail}
              </p>
            ))}
          </div>
        </div>
      )}

      <div
        className="card-industrial"
        style={{ padding: '1.25rem 1.5rem', borderLeft: '4px solid var(--neo-green)' }}
      >
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Local encryption happens in the browser when the protected runtime key is available. The
          generated payload is intended for on-chain submission through{' '}
          <code>
            {oracleState?.domain ||
              selectedNetworkConfig.oracleDomain ||
              'configured oracle contract'}
          </code>
          . You can also move <code>json_path</code> or <code>script</code> into the encrypted JSON
          if you want those fields hidden from the public transaction.
        </p>
      </div>

      <div
        className="card-industrial"
        style={{ padding: '1.25rem 1.5rem', borderLeft: '4px solid var(--accent-blue)' }}
      >
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Direct test path: set callback hash to <code>{defaultCallbackHash}</code>, keep callback
          method as <code>onOracleResult</code>, pre-fund the Oracle credit, submit with NEP-21,
          then read back with <code>getCallback(requestId)</code>.
        </p>
      </div>

      <OracleSettings onApplyPreset={applyOraclePreset} />

      <OracleRequestForm
        oracleConfidentialJson={oracleConfidentialJson}
        setOracleConfidentialJson={setOracleConfidentialJson}
        keySummary={keySummary}
        isEncrypting={isEncrypting}
        oracleKeyMeta={oracleKeyMeta}
        oracleEncryptedParams={oracleEncryptedParams}
        setOracleEncryptedParams={setOracleEncryptedParams}
        onEncryptPatch={encryptConfidentialPatch}
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
        onGeneratePackage={generateOnchainPackage}
      />

      {generatedRequest && (
        <OracleResponseViewer
          generatedRequest={generatedRequest}
          oracleState={oracleState}
          walletCallbackHash={walletCallbackHash}
          walletCallbackMethod={walletCallbackMethod}
          oracleContract={selectedNetworkConfig.oracleContract}
          payloadBase64={payloadBase64}
          neoRpcInvoke={neoRpcInvoke}
          callbackQueryTemplate={callbackQueryTemplate}
          copiedItem={copiedItem}
          onCopy={handleCopy}
          isWalletSubmitting={isWalletSubmitting}
          onSubmitWithWallet={submitGeneratedWithWallet}
          canSubmitWithWallet={walletSubmitReady}
          readinessLabel={packageReadiness.label}
          readinessDetail={packageReadiness.detail}
          readinessTone={packageReadiness.tone}
        />
      )}
    </div>
  );
}
