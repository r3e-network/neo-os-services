'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, ArrowRight, Copy } from 'lucide-react';
import type { OracleKeyMeta, OracleState } from '@/lib/dashboard-types';
import { parseOracleKeyMeta } from '@/lib/dashboard-types';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { encryptJsonWithOraclePublicKey } from '@/lib/browser-encryption';
import {
  buildCallbackQueryTemplate,
  buildNeoRequestContractCall,
  buildNeoRequestInvoke,
  copyText,
  encodeUtf8Base64,
} from '@/lib/neo-snippets';
import { getDashboardNetworkConfig } from '@/components/dashboard/networkSelection';
import {
  ORACLE_KEY_LOADING_STATUS,
  ORACLE_STATE_LOADING_STATUS,
  buildNetworkQueryPart,
  evaluateOracleKeyStatus,
  evaluateOracleStateStatus,
  getReadinessAccent,
  readOracleStateFromBody,
  type RuntimeStatus,
} from '@/components/dashboard/oracleReadiness';
import { PresetBar, type PresetId } from './PresetBar';
import { RequestTypePanel } from './RequestTypePanel';
import { SealedBlobPanel } from './SealedBlobPanel';
import { EncryptionErrorBanner } from './EncryptionErrorBanner';
import { SnippetIssuesBanner } from './SnippetIssuesBanner';
import { KeyMetaPanels } from './KeyMetaPanels';
import { ZeroCodeTestModePanel } from './ZeroCodeTestModePanel';
import { CallbackReadbackPanel } from './CallbackReadbackPanel';
import { NeoLineManualEntryPanel } from './NeoLineManualEntryPanel';
import { NeoN3CallArgumentsPanel } from './NeoN3CallArgumentsPanel';
const neoGasHash = '0xd2a4cff31913016155e38e474a2c06d08be276cf';

function isHash160(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function isNeoMethodName(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value.trim());
}

type StarterStudioProps = {
  embedded?: boolean;
};

function buildDefaultConfidentialPatch(flow: string, useScript: boolean, script: string) {
  if (flow === 'oracle_provider') {
    if (useScript && script.trim()) {
      return JSON.stringify(
        {
          json_path: 'price',
          script: script.trim(),
          entry_point: 'process',
        },
        null,
        2
      );
    }
    return JSON.stringify({ json_path: 'price' }, null, 2);
  }

  if (flow === 'oracle_custom') {
    const payload: Record<string, unknown> = {
      headers: {},
      json_path: '',
    };
    if (useScript && script.trim()) {
      payload.script = script.trim();
      payload.entry_point = 'process';
    }
    return JSON.stringify(payload, null, 2);
  }

  if (flow === 'compute_builtin') {
    return JSON.stringify(
      {
        mode: 'builtin',
        function: 'privacy.mask',
        input: { value: '', unmasked_left: 0, unmasked_right: 0 },
        target_chain: 'neo_n3',
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      mode: 'builtin',
      function: 'math.modexp',
      input: { base: '', exponent: '', modulus: '' },
      target_chain: 'neo_n3',
    },
    null,
    2
  );
}

export function StarterStudio({ embedded = false }: StarterStudioProps) {
  const initialNetworkConfig = getDashboardNetworkConfig('testnet');
  const [selectedNetworkKey, setSelectedNetworkKey] = useState(initialNetworkConfig.networkKey);
  const selectedNetworkConfig = getDashboardNetworkConfig(selectedNetworkKey);
  const universalConsumer = selectedNetworkConfig.callbackConsumer;
  const [flow, setFlow] = useState('oracle_provider');
  const [symbol, setSymbol] = useState('TWELVEDATA:NEO-USD');
  const [customUrl, setCustomUrl] = useState('');
  const [jsonPath, setJsonPath] = useState('price');
  const [targetChain, setTargetChain] = useState('neo_n3');
  const [useEncrypted, setUseEncrypted] = useState(true);
  const [useScript, setUseScript] = useState(false);
  const [script, setScript] = useState('');
  const [manualCallbackHash, setManualCallbackHash] = useState(
    initialNetworkConfig.callbackConsumer
  );
  const [manualCallbackMethod, setManualCallbackMethod] = useState('onOracleResult');
  const [confidentialJson, setConfidentialJson] = useState(
    buildDefaultConfidentialPatch('oracle_provider', false, '')
  );
  const [encryptedBlob, setEncryptedBlob] = useState('');
  const [oracleKeyMeta, setOracleKeyMeta] = useState<OracleKeyMeta | null>(null);
  const [oracleKeyStatus, setOracleKeyStatus] = useState<RuntimeStatus>(ORACLE_KEY_LOADING_STATUS);
  const [oracleState, setOracleState] = useState<OracleState | null>(null);
  const [oracleStateStatus, setOracleStateStatus] = useState<RuntimeStatus>(
    ORACLE_STATE_LOADING_STATUS
  );
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [encryptionError, setEncryptionError] = useState('');
  const [copiedItem, setCopiedItem] = useState<string | null>(null);

  const loadOracleKey = useCallback(async (networkKey: string) => {
    setOracleKeyStatus(ORACLE_KEY_LOADING_STATUS);
    try {
      const response = await fetch(
        `/api/oracle/public-key${buildNetworkQueryPart(networkKey, '?')}`
      );
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
      return meta;
    } catch (err) {
      setOracleKeyMeta(null);
      setOracleKeyStatus({
        level: 'blocked',
        label: 'Public key unavailable',
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }, []);

  const loadOracleState = useCallback(async (networkKey: string) => {
    setOracleStateStatus(ORACLE_STATE_LOADING_STATUS);
    try {
      const response = await fetch(
        `/api/onchain/state?limit=20${buildNetworkQueryPart(networkKey, '&')}`
      );
      const body = await response.json().catch(() => ({}));
      const bodyNetworkConfig = getDashboardNetworkConfig(body?.network || networkKey);
      setSelectedNetworkKey(bodyNetworkConfig.networkKey);
      setOracleState(readOracleStateFromBody(body));
      setOracleStateStatus(
        evaluateOracleStateStatus({
          responseOk: response.ok,
          responseStatus: response.status,
          body,
          selectedNetworkName: bodyNetworkConfig.name,
        })
      );
    } catch (err) {
      setOracleState(null);
      setOracleStateStatus({
        level: 'blocked',
        label: 'On-chain state unavailable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    const browserNetworkConfig = getDashboardNetworkConfig();
    setSelectedNetworkKey(browserNetworkConfig.networkKey);
    setManualCallbackHash(browserNetworkConfig.callbackConsumer);
    void loadOracleKey(browserNetworkConfig.networkKey);
    void loadOracleState(browserNetworkConfig.networkKey);
  }, [loadOracleKey, loadOracleState]);

  useEffect(() => {
    setEncryptedBlob('');
    setConfidentialJson(buildDefaultConfidentialPatch(flow, useScript, script));
  }, [flow, script, useScript]);

  function applyPreset(preset: PresetId) {
    if (preset === 'oracle_quote') {
      setFlow('oracle_provider');
      setSymbol('TWELVEDATA:NEO-USD');
      setJsonPath('price');
      setTargetChain('neo_n3');
      setUseEncrypted(false);
      setUseScript(false);
      setScript('');
      setConfidentialJson(buildDefaultConfidentialPatch('oracle_provider', false, ''));
      setEncryptedBlob('');
      return;
    }

    if (preset === 'oracle_private_api') {
      setFlow('oracle_custom');
      setCustomUrl('');
      setJsonPath('');
      setTargetChain('neo_n3');
      setUseEncrypted(true);
      setUseScript(false);
      setScript('');
      setConfidentialJson(
        JSON.stringify(
          {
            headers: {},
            json_path: '',
          },
          null,
          2
        )
      );
      setEncryptedBlob('');
      return;
    }

    if (preset === 'oracle_boolean') {
      setFlow('oracle_custom');
      setCustomUrl('');
      setJsonPath('');
      setTargetChain('neo_n3');
      setUseEncrypted(true);
      setUseScript(true);
      const nextScript = '';
      setScript(nextScript);
      setConfidentialJson(
        JSON.stringify(
          {
            headers: {},
            json_path: '',
            script: nextScript,
            entry_point: 'process',
          },
          null,
          2
        )
      );
      setEncryptedBlob('');
      return;
    }

    if (preset === 'compute_mask') {
      setFlow('compute_builtin');
      setTargetChain('neo_n3');
      setUseEncrypted(false);
      setUseScript(false);
      setConfidentialJson(buildDefaultConfidentialPatch('compute_builtin', false, ''));
      setEncryptedBlob('');
      return;
    }

    setFlow('compute_encrypted');
    setTargetChain('neo_n3');
    setUseEncrypted(true);
    setUseScript(false);
    setConfidentialJson(buildDefaultConfidentialPatch('compute_encrypted', false, ''));
    setEncryptedBlob('');
  }

  async function encryptPatch() {
    setIsEncrypting(true);
    setEncryptionError('');
    try {
      const keyMeta = oracleKeyMeta?.public_key
        ? oracleKeyMeta
        : await loadOracleKey(selectedNetworkKey);

      if (!keyMeta?.public_key) {
        throw new Error(oracleKeyStatus.detail || 'Oracle public key unavailable');
      }
      const ciphertext = await encryptJsonWithOraclePublicKey(keyMeta.public_key, confidentialJson);
      setEncryptedBlob(ciphertext);
    } catch (error) {
      setEncryptedBlob('');
      setEncryptionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsEncrypting(false);
    }
  }

  async function handleCopy(id: string, value: string) {
    await copyText(value);
    setCopiedItem(id);
    setTimeout(() => setCopiedItem(null), 1500);
  }

  const generated = useMemo(() => {
    const payload: Record<string, unknown> = { target_chain: targetChain };
    let requestType = 'privacy_oracle';

    if (flow === 'oracle_provider') {
      payload.symbol = symbol;
      if (useEncrypted) {
        payload.encrypted_payload = encryptedBlob || '<sealed confidential patch>';
      } else {
        if (jsonPath.trim()) payload.json_path = jsonPath.trim();
        if (useScript && script.trim()) {
          payload.script = script.trim();
          payload.entry_point = 'process';
        }
      }
      requestType = useEncrypted ? 'privacy_oracle' : 'oracle';
    } else if (flow === 'oracle_custom') {
      payload.url = customUrl;
      if (useEncrypted) {
        payload.encrypted_params = encryptedBlob || '<sealed confidential patch>';
      } else {
        if (jsonPath.trim()) payload.json_path = jsonPath.trim();
        if (useScript && script.trim()) {
          payload.script = script.trim();
          payload.entry_point = 'process';
        }
      }
      requestType = useEncrypted ? 'privacy_oracle' : 'oracle';
    } else if (flow === 'compute_builtin') {
      requestType = 'compute';
      if (useEncrypted) {
        payload.encrypted_payload =
          encryptedBlob || buildDefaultConfidentialPatch('compute_builtin', false, '');
      } else {
        payload.mode = 'builtin';
        payload.function = 'privacy.mask';
        payload.input = { value: '13812345678', unmasked_left: 3, unmasked_right: 4 };
      }
    } else {
      requestType = 'compute';
      payload.encrypted_payload =
        encryptedBlob || buildDefaultConfidentialPatch('compute_encrypted', false, '');
    }

    return { requestType, payload };
  }, [
    customUrl,
    encryptedBlob,
    flow,
    jsonPath,
    script,
    symbol,
    targetChain,
    useEncrypted,
    useScript,
  ]);

  const normalizedCallbackHash = manualCallbackHash.trim();
  const normalizedCallbackMethod = manualCallbackMethod.trim();
  const callbackHashForSnippet = isHash160(normalizedCallbackHash)
    ? normalizedCallbackHash
    : '<valid 0x-prefixed Hash160 callback contract>';
  const callbackMethodForSnippet = isNeoMethodName(normalizedCallbackMethod)
    ? normalizedCallbackMethod
    : '<validCallbackMethod>';
  const snippetIssues = useMemo(() => {
    const issues: string[] = [];
    if (!isHash160(normalizedCallbackHash)) {
      issues.push(
        'Enter a 0x-prefixed 20-byte callback contract hash before using wallet or RPC snippets.'
      );
    }
    if (!isNeoMethodName(normalizedCallbackMethod)) {
      issues.push('Enter a callback method name using letters, numbers, or underscores.');
    }
    if (useEncrypted && !encryptedBlob) {
      issues.push('Encrypt the confidential patch before submitting an encrypted flow.');
    }
    if (useEncrypted && oracleKeyStatus.level !== 'ready') {
      issues.push(`${oracleKeyStatus.label}: ${oracleKeyStatus.detail}`);
    }
    if (oracleStateStatus.level !== 'ready') {
      issues.push(`${oracleStateStatus.label}: ${oracleStateStatus.detail}`);
    }
    return issues;
  }, [
    encryptedBlob,
    normalizedCallbackHash,
    normalizedCallbackMethod,
    oracleKeyStatus,
    oracleStateStatus,
    useEncrypted,
  ]);

  const payloadJson = JSON.stringify(generated.payload, null, 2);
  const compactPayloadJson = JSON.stringify(generated.payload);
  const payloadBase64 = useMemo(() => encodeUtf8Base64(compactPayloadJson), [compactPayloadJson]);
  const oracleContract = oracleState?.contract || selectedNetworkConfig.oracleContract;
  const oracleDomain = oracleState?.domain || selectedNetworkConfig.oracleDomain;
  const requestFeeDisplay = oracleState?.request_fee_display || 'unverified';
  const readinessMessages = [oracleStateStatus, ...(useEncrypted ? [oracleKeyStatus] : [])].filter(
    (status) => status.level !== 'ready'
  );
  const readinessAccent = getReadinessAccent(readinessMessages);
  const neoN3Snippet = buildNeoRequestContractCall({
    requestType: generated.requestType,
    compactPayloadJson,
  });

  const neoRpcInvoke = buildNeoRequestInvoke({
    oracleContract,
    requestType: generated.requestType,
    payloadBase64,
    callbackHash: callbackHashForSnippet,
    callbackMethod: callbackMethodForSnippet,
  });
  const callbackQueryTemplate = buildCallbackQueryTemplate(callbackHashForSnippet);

  return (
    <div className={embedded ? 'fade-up' : 'fade-in'}>
      {!embedded && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
            <Boxes size={14} color="var(--neo-green)" />
            <span
              style={{
                fontSize: '0.7rem',
                fontWeight: 800,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: 0,
                fontFamily: 'var(--font-mono)',
              }}
            >
              INTERACTIVE STARTER STUDIO
            </span>
          </div>
          <h1>Starter Studio</h1>
        </>
      )}

      {embedded ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            borderBottom: '1px solid var(--border-dim)',
            paddingBottom: '1rem',
            marginBottom: '2rem',
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
              Starter Studio
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
              Choose a user flow, encrypt locally if needed, then generate payload JSON and Neo N3
              request snippets instantly.
            </p>
          </div>
        </div>
      ) : (
        <p
          className="lead"
          style={{
            fontSize: '1.1rem',
            color: 'var(--text-primary)',
            marginBottom: '2.5rem',
            lineHeight: 1.6,
          }}
        >
          Pick a user flow, choose a data source or built-in function, optionally encrypt the
          confidential patch in-browser, and Morpheus will generate the payload and Neo N3 request
          snippet you need next.
        </p>
      )}

      {readinessMessages.length > 0 && (
        <div
          className="card-industrial"
          style={{
            padding: '1.25rem 1.5rem',
            borderLeft: `4px solid ${readinessAccent}`,
            marginBottom: '1.5rem',
          }}
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

      <div className="card-industrial" style={{ padding: '1rem 1.25rem', marginBottom: '1.5rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '1rem',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ color: 'var(--text-secondary)' }}>
            Network: <code>{selectedNetworkConfig.name}</code>
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>
            Oracle: <code>{oracleDomain || oracleContract || 'unverified'}</code>
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>
            Fee: <code>{requestFeeDisplay}</code>
          </span>
        </div>
      </div>

      <PresetBar onApplyPreset={applyPreset} />

      <div className="grid grid-2" style={{ gap: '2rem', alignItems: 'start' }}>
        <div className="card-industrial" style={{ padding: '1.75rem' }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>1. Configure Flow</h3>

          <div style={{ display: 'grid', gap: '1rem' }}>
            <label>
              <div
                style={{
                  marginBottom: '0.35rem',
                  color: 'var(--text-secondary)',
                  fontSize: '0.85rem',
                }}
              >
                Flow
              </div>
              <select
                className="neo-select"
                value={flow}
                onChange={(event) => setFlow(event.target.value)}
              >
                <option value="oracle_provider">Oracle: Built-in Provider</option>
                <option value="oracle_custom">Oracle: Custom URL</option>
                <option value="compute_builtin">Compute: Built-in Function</option>
                <option value="compute_encrypted">Compute: Encrypted Built-in</option>
              </select>
            </label>

            <label>
              <div
                style={{
                  marginBottom: '0.35rem',
                  color: 'var(--text-secondary)',
                  fontSize: '0.85rem',
                }}
              >
                Target Chain
              </div>
              <select
                className="neo-select"
                value={targetChain}
                onChange={(event) => setTargetChain(event.target.value)}
              >
                <option value="neo_n3">Neo N3</option>
              </select>
            </label>

            {flow === 'oracle_provider' && (
              <>
                <label>
                  <div
                    style={{
                      marginBottom: '0.35rem',
                      color: 'var(--text-secondary)',
                      fontSize: '0.85rem',
                    }}
                  >
                    Source
                  </div>
                  <div
                    className="badge-outline"
                    style={{
                      minHeight: '44px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    Provider inferred from pair prefix
                  </div>
                </label>
                <label>
                  <div
                    style={{
                      marginBottom: '0.35rem',
                      color: 'var(--text-secondary)',
                      fontSize: '0.85rem',
                    }}
                  >
                    Canonical Pair Key
                  </div>
                  <input
                    className="neo-input"
                    value={symbol}
                    onChange={(event) => setSymbol(event.target.value)}
                  />
                </label>
              </>
            )}

            {flow === 'oracle_custom' && (
              <label>
                <div
                  style={{
                    marginBottom: '0.35rem',
                    color: 'var(--text-secondary)',
                    fontSize: '0.85rem',
                  }}
                >
                  Custom URL
                </div>
                <input
                  className="neo-input"
                  value={customUrl}
                  onChange={(event) => setCustomUrl(event.target.value)}
                />
              </label>
            )}

            {(flow === 'oracle_provider' || flow === 'oracle_custom') && !useEncrypted && (
              <>
                <label>
                  <div
                    style={{
                      marginBottom: '0.35rem',
                      color: 'var(--text-secondary)',
                      fontSize: '0.85rem',
                    }}
                  >
                    JSON Path
                  </div>
                  <input
                    className="neo-input"
                    value={jsonPath}
                    onChange={(event) => setJsonPath(event.target.value)}
                  />
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    color: 'var(--text-secondary)',
                    fontSize: '0.9rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={useScript}
                    onChange={(event) => setUseScript(event.target.checked)}
                  />
                  Enable custom JS reduction
                </label>
                {useScript && (
                  <textarea
                    className="code-editor"
                    value={script}
                    onChange={(event) => setScript(event.target.value)}
                    style={{ minHeight: '140px' }}
                  />
                )}
                {useScript && (
                  <div
                    style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}
                  >
                    If the inline script is too large for the on-chain payload, move it into a Neo
                    N3 contract getter and place a <code>script_ref</code> object into the
                    confidential JSON patch instead.
                  </div>
                )}
              </>
            )}

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                color: 'var(--text-secondary)',
                fontSize: '0.9rem',
              }}
            >
              <input
                type="checkbox"
                checked={useEncrypted}
                onChange={(event) => setUseEncrypted(event.target.checked)}
              />
              Seal sensitive fields before submission
            </label>

            <label>
              <div
                style={{
                  marginBottom: '0.35rem',
                  color: 'var(--text-secondary)',
                  fontSize: '0.85rem',
                }}
              >
                Direct Wallet Callback Hash
              </div>
              <input
                className="neo-input"
                value={manualCallbackHash}
                onChange={(event) => setManualCallbackHash(event.target.value)}
                aria-invalid={!isHash160(normalizedCallbackHash)}
                style={
                  !isHash160(normalizedCallbackHash)
                    ? { borderColor: 'rgba(239, 68, 68, 0.65)' }
                    : undefined
                }
              />
            </label>

            <label>
              <div
                style={{
                  marginBottom: '0.35rem',
                  color: 'var(--text-secondary)',
                  fontSize: '0.85rem',
                }}
              >
                Callback Method
              </div>
              <input
                className="neo-input"
                value={manualCallbackMethod}
                onChange={(event) => setManualCallbackMethod(event.target.value)}
                aria-invalid={!isNeoMethodName(normalizedCallbackMethod)}
                style={
                  !isNeoMethodName(normalizedCallbackMethod)
                    ? { borderColor: 'rgba(239, 68, 68, 0.65)' }
                    : undefined
                }
              />
            </label>

            {useEncrypted && (
              <>
                <KeyMetaPanels oracleKeyMeta={oracleKeyMeta} keyStatus={oracleKeyStatus} />

                <label>
                  <div
                    style={{
                      marginBottom: '0.35rem',
                      color: 'var(--text-secondary)',
                      fontSize: '0.85rem',
                    }}
                  >
                    Confidential JSON Patch
                  </div>
                  <textarea
                    className="code-editor"
                    value={confidentialJson}
                    onChange={(event) => setConfidentialJson(event.target.value)}
                    style={{ minHeight: '180px' }}
                  />
                </label>

                <div
                  style={{
                    display: 'flex',
                    gap: '0.75rem',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    className="btn-ata"
                    onClick={() => void encryptPatch()}
                    disabled={isEncrypting || oracleKeyStatus.level !== 'ready'}
                    title={oracleKeyStatus.level !== 'ready' ? oracleKeyStatus.detail : undefined}
                    style={{ justifyContent: 'center' }}
                  >
                    {isEncrypting ? 'Encrypting...' : 'Encrypt Patch Locally'}
                  </button>
                  {encryptedBlob && (
                    <button
                      className="btn-secondary"
                      style={{ border: '1px solid var(--border-dim)' }}
                      onClick={() => void handleCopy('ciphertext', encryptedBlob)}
                    >
                      <Copy size={14} />{' '}
                      {copiedItem === 'ciphertext' ? 'Copied Ciphertext' : 'Copy Ciphertext'}
                    </button>
                  )}
                </div>

                {encryptionError && <EncryptionErrorBanner message={encryptionError} />}

                {encryptedBlob && <SealedBlobPanel blob={encryptedBlob} />}
              </>
            )}
          </div>
        </div>

        <div className="card-industrial" style={{ padding: '1.75rem' }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>2. Use The Output</h3>

          <div style={{ display: 'grid', gap: '1rem' }}>
            {snippetIssues.length > 0 && <SnippetIssuesBanner issues={snippetIssues} />}

            <RequestTypePanel requestType={generated.requestType} />

            <CodeBlock language="json" title="Payload JSON" code={payloadJson} />
            <CodeBlock language="csharp" title="Neo N3 Request Snippet" code={neoN3Snippet} />
            <CodeBlock
              language="text"
              title="Payload ByteArray (Base64 UTF-8)"
              code={payloadBase64}
            />
            <CodeBlock
              language="json"
              title="Neo N3 RPC invokeFunction Params"
              code={neoRpcInvoke}
            />
            <CodeBlock
              language="json"
              title="Callback Query Template"
              code={callbackQueryTemplate}
            />

            <NeoLineManualEntryPanel
              oracleHash={oracleContract}
              requestType={generated.requestType}
              callbackHash={callbackHashForSnippet}
              callbackMethod={callbackMethodForSnippet}
            />

            <NeoN3CallArgumentsPanel
              requestType={generated.requestType}
              callbackHash={callbackHashForSnippet}
              callbackMethod={callbackMethodForSnippet}
              requestFeeDisplay={requestFeeDisplay}
            />

            <ZeroCodeTestModePanel
              universalConsumer={universalConsumer}
              oracleHash={oracleContract}
              environmentLabel={selectedNetworkConfig.label}
              neoGasHash={neoGasHash}
            />

            <CallbackReadbackPanel
              requestType={generated.requestType}
              oracleHash={oracleContract}
              universalConsumer={universalConsumer}
            />
          </div>
        </div>
      </div>

      {!embedded && (
        <div className="grid grid-2" style={{ gap: '1.5rem', marginTop: '2.5rem' }}>
          <Link
            href="/docs/templates"
            className="card-industrial"
            style={{ padding: '1.75rem', textDecoration: 'none' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                Static Templates
              </span>
              <ArrowRight size={18} color="var(--neo-green)" />
            </div>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.85rem', marginBottom: 0 }}>
              Go back to the copy-ready template library if you just want canned payloads.
            </p>
          </Link>
          <Link
            href="/explorer"
            className="card-industrial"
            style={{ padding: '1.75rem', textDecoration: 'none' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                Open Explorer
              </span>
              <ArrowRight size={18} color="var(--neo-green)" />
            </div>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.85rem', marginBottom: 0 }}>
              Use the live Oracle Requests and Private Compute workspaces after you choose a flow
              here.
            </p>
          </Link>
        </div>
      )}
    </div>
  );
}
