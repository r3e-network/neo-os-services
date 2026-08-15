'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OracleState, WalletSubmitResult } from '@/lib/dashboard-types';
import { invokeMorpheusOracleRequest } from '@/lib/nep21';
import { resolveBuiltinComputeFunction } from './computeBuiltins';
import {
  buildCallbackQueryTemplate,
  buildNeoRequestContractCall,
  buildNeoRequestInvoke,
  encodeUtf8Base64,
} from '@/lib/neo-snippets';

import { ComputeFunctions } from './ComputeFunctions';
import { ComputeEditor } from './ComputeEditor';
import { ComputeOutput } from './ComputeOutput';
import { getDashboardNetworkConfig } from './networkSelection';
import {
  ORACLE_STATE_LOADING_STATUS,
  buildNetworkQueryPart,
  derivePackageReadiness,
  evaluateOracleStateStatus,
  getReadinessAccent,
  readOracleStateFromBody,
  type RuntimeStatus,
} from './oracleReadiness';

interface ComputeTabProps {
  computeFunctions?: unknown;
  setOutput: (value: string) => void;
}

interface SafeAuthoringPreviewInput {
  selectedFunc: string;
  input: Record<string, unknown>;
  userCode: string;
  scriptRefJson: string;
}

function decodeBase64(value: string) {
  if (typeof window !== 'undefined') return window.atob(value);
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseScriptRef(scriptRefJson: string) {
  try {
    const parsed = scriptRefJson.trim() ? JSON.parse(scriptRefJson) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function buildSafeAuthoringPreview({
  selectedFunc,
  input,
  userCode,
  scriptRefJson,
}: SafeAuthoringPreviewInput) {
  if (selectedFunc.includes('timestamp')) {
    return {
      label: typeof input.label === 'string' && input.label.trim() ? input.label : 'request',
      generated_at: Math.floor(Date.now() / 1000),
    };
  }

  if (selectedFunc.includes('base64_decode')) {
    return {
      decoded: decodeBase64(typeof input.value === 'string' ? input.value : ''),
    };
  }

  const previewBuiltin = resolveBuiltinComputeFunction(selectedFunc);
  if (previewBuiltin) {
    return {
      mode: 'builtin',
      function: previewBuiltin,
      input,
    };
  }

  if (selectedFunc.includes('wasm')) {
    return {
      mode: 'wasm',
      note: 'WASM payload shape validated; browser authoring check does not execute modules.',
    };
  }

  const scriptRef = parseScriptRef(scriptRefJson);
  return {
    mode: 'script',
    entry_point: 'process',
    input,
    script_ref: scriptRef,
    inline_script_bytes: scriptRef ? 0 : new TextEncoder().encode(userCode).length,
    executed: false,
  };
}

export function ComputeTab({ computeFunctions: _computeFunctions, setOutput }: ComputeTabProps) {
  const initialNetworkConfig = getDashboardNetworkConfig();
  const [selectedNetworkKey, setSelectedNetworkKey] = useState(initialNetworkConfig.networkKey);
  const selectedNetworkConfig = getDashboardNetworkConfig(selectedNetworkKey);
  const [selectedFunc, setSelectedFunc] = useState<string>('');
  const [computeInput, setComputeInput] = useState('{}');
  const [userCode, setUserCode] = useState(
    `function process(input, helpers) {\n return {\n received: input,\n generated_at: helpers.getCurrentTimestamp(),\n };\n}`
  );
  const [scriptRefJson, setScriptRefJson] = useState('');
  const [isSimulating, setIsSimulating] = useState(false);
  const [generatedPackage, setGeneratedPackage] = useState<{
    requestType: string;
    payload: Record<string, unknown>;
    payloadJson: string;
    neoN3Snippet: string;
  } | null>(null);
  const [walletCallbackHash, setWalletCallbackHash] = useState(
    initialNetworkConfig.callbackConsumer
  );
  const [walletCallbackMethod, setWalletCallbackMethod] = useState('onOracleResult');
  const [oracleState, setOracleState] = useState<OracleState | null>(null);
  const [oracleStateStatus, setOracleStateStatus] = useState<RuntimeStatus>(
    ORACLE_STATE_LOADING_STATUS
  );
  const [copiedItem, setCopiedItem] = useState<string | null>(null);
  const [isWalletSubmitting, setIsWalletSubmitting] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      console.error('Failed to load on-chain compute state', err);
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
    setWalletCallbackHash(browserNetworkConfig.callbackConsumer);
    void loadOracleState(browserNetworkConfig.networkKey);
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    };
  }, [loadOracleState]);

  function applyComputePreset(name: string) {
    setSelectedFunc(name);
    if (name.includes('timestamp')) {
      setUserCode(
        `function process(input, helpers) {\n return {\n label: input.label,\n generated_at: helpers.getCurrentTimestamp(),\n };\n}`
      );
      setComputeInput('{\n "label": ""\n}');
      return;
    }
    if (name.includes('base64_decode')) {
      setUserCode(
        `function process(input, helpers) {\n return {\n decoded: helpers.base64Decode(input.value || ""),\n };\n}`
      );
      setComputeInput('{\n "value": ""\n}');
      return;
    }
    if (name.includes('privacy.mask')) {
      setUserCode(
        `function process(input, helpers) {\n return {\n mode: "builtin",\n function: "privacy.mask",\n input\n };\n}`
      );
      setComputeInput('{\n "value": "",\n "unmasked_left": 0,\n "unmasked_right": 0\n}');
      return;
    }
    if (name.includes('public_signal_hash')) {
      setUserCode(
        `function process(input, helpers) {\n return {\n mode: "builtin",\n function: "zkp.public_signal_hash",\n input\n };\n}`
      );
      setComputeInput('{\n "circuit_id": "",\n "signals": []\n}');
      return;
    }
    if (name.includes('groth16.verify')) {
      setUserCode(
        `function process(input, helpers) {\n return {\n mode: "builtin",\n function: "zkp.groth16.verify",\n input\n };\n}`
      );
      setComputeInput('{\n "verifying_key": {},\n "public_signals": [],\n "proof": {}\n}');
      return;
    }
    if (name.includes('zerc20.single_withdraw.verify')) {
      setUserCode(
        `function process(input, helpers) {\n return {\n mode: "builtin",\n function: "zkp.zerc20.single_withdraw.verify",\n input\n };\n}`
      );
      setComputeInput('{\n "public_inputs": {},\n "proof": {}\n}');
      return;
    }
    if (name.includes('modexp')) {
      setUserCode(
        `function process(input, helpers) {\n return {\n mode: "builtin",\n function: "math.modexp",\n input\n };\n}`
      );
      setComputeInput('{\n "base": "",\n "exponent": "",\n "modulus": ""\n}');
      return;
    }
    if (name.includes('matrix')) {
      setUserCode(
        `function process(input, helpers) {\n return {\n mode: "builtin",\n function: "matrix.multiply",\n input\n };\n}`
      );
      setComputeInput('{\n "left": [],\n "right": []\n}');
      return;
    }
    if (name.includes('wasm')) {
      setUserCode(
        `// WASM is the recommended path for stronger isolation.\nfunction process(input, helpers) {\n return {\n mode: "wasm",\n note: "Compile a .wasm module and place it into wasm_base64."\n };\n}`
      );
      setComputeInput('{\n "wasm_base64": "",\n "input": {}\n}');
      return;
    }
    setUserCode(
      `function process(input, helpers) {\n return {\n received: input,\n generated_at: helpers.getCurrentTimestamp(),\n };\n}`
    );
    setComputeInput('{}');
  }

  async function handleCopy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedItem(id);
    } catch {
      setOutput('Copy failed. Check browser clipboard permissions and try again.');
    }
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopiedItem(null), 1500);
  }

  async function submitGeneratedWithWallet() {
    if (!generatedPackage) return;
    if (!oracleSubmitReady) {
      setOutput(`!! NEP-21 wallet submit blocked: ${oracleStateStatus.detail}`);
      return;
    }
    setIsWalletSubmitting(true);
    setOutput('>> Waiting for NEP-21 wallet approval...');
    try {
      const result = (await invokeMorpheusOracleRequest({
        oracleHash: oracleContract,
        requestType: generatedPackage.requestType,
        payloadBase64,
        callbackHash: walletCallbackHash,
        callbackMethod: walletCallbackMethod,
        expectedNetworkMagic: selectedNetworkConfig.networkMagic,
        expectedNetworkLabel: selectedNetworkConfig.name,
      })) as WalletSubmitResult;
      setOutput(
        [
          '>> NEP-21 wallet submitted Compute request.',
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

  const handleExecute = async () => {
    setIsSimulating(true);
    const logs: string[] = [
      '>> Validating local authoring payload...',
      '>> This check does not execute edited JavaScript, contact the live worker, or touch the blockchain.',
    ];

    try {
      const input = JSON.parse(computeInput) as Record<string, unknown>;
      const result = buildSafeAuthoringPreview({ selectedFunc, input, userCode, scriptRefJson });
      logs.push('>> Authoring check complete.');
      logs.push(`>> Preview: ${JSON.stringify(result, null, 2)}`);

      setOutput(logs.join('\n'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logs.push(`!! [ERROR] ${message}`);
      setOutput(logs.join('\n'));
    } finally {
      setIsSimulating(false);
    }
  };

  const generateOnchainPackage = () => {
    let payload: Record<string, unknown>;
    let parsedInput: Record<string, unknown> = {};
    try {
      parsedInput = JSON.parse(computeInput);
      if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
        throw new Error('Compute input must be a JSON object.');
      }
    } catch (err: unknown) {
      setOutput(`!! [ERROR] ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const packageBuiltin = resolveBuiltinComputeFunction(selectedFunc);
    if (packageBuiltin) {
      payload = {
        mode: 'builtin',
        function: packageBuiltin,
        input: parsedInput,
        target_chain: 'neo_n3',
      };
    } else if (selectedFunc.includes('wasm')) {
      payload = {
        mode: 'wasm',
        wasm_base64: typeof parsedInput.wasm_base64 === 'string' ? parsedInput.wasm_base64 : '',
        input:
          parsedInput.input &&
          typeof parsedInput.input === 'object' &&
          !Array.isArray(parsedInput.input)
            ? (parsedInput.input as Record<string, unknown>)
            : {},
        target_chain: 'neo_n3',
      };
    } else {
      let parsedScriptRef: Record<string, unknown> | null = null;
      try {
        parsedScriptRef = scriptRefJson.trim() ? JSON.parse(scriptRefJson) : null;
      } catch {
        parsedScriptRef = null;
      }
      payload = {
        mode: 'script',
        entry_point: 'process',
        input: parsedInput,
        target_chain: 'neo_n3',
      };
      if (parsedScriptRef && typeof parsedScriptRef === 'object') {
        payload.script_ref = parsedScriptRef;
      } else {
        payload.script = userCode;
      }
    }

    const payloadJson = JSON.stringify(payload, null, 2);
    const compactPayloadJson = JSON.stringify(payload);
    const neoN3Snippet = buildNeoRequestContractCall({
      requestType: 'compute',
      compactPayloadJson,
    });

    setGeneratedPackage({
      requestType: 'compute',
      payload,
      payloadJson,
      neoN3Snippet,
    });

    setOutput(
      [
        '>> Compute request package generated.',
        '>> Request type: compute',
        `>> Oracle readiness: ${oracleStateStatus.label}`,
        `>> Neo N3 request fee: ${oracleState?.request_fee_display || 'unverified'}`,
        `>> Oracle contract: ${oracleContract}`,
        '>> Submit this payload through the on-chain Oracle contract.',
        '',
        payloadJson,
      ].join('\n')
    );
  };

  const oracleContract = oracleState?.contract || selectedNetworkConfig.oracleContract;
  const oracleSubmitReady = oracleStateStatus.level === 'ready' && Boolean(oracleState?.contract);
  const packageReadiness = derivePackageReadiness({
    oracleSubmitReady,
    oracleStateStatus,
  });
  const computeStatusAccent =
    oracleStateStatus.level === 'ready'
      ? 'var(--neo-green)'
      : oracleStateStatus.level === 'loading'
        ? 'var(--accent-blue)'
        : 'var(--warning)';
  const readinessAccent = getReadinessAccent([oracleStateStatus], computeStatusAccent);
  const payloadBase64 = generatedPackage
    ? encodeUtf8Base64(JSON.stringify(generatedPackage.payload))
    : '';
  const neoRpcInvoke = generatedPackage
    ? buildNeoRequestInvoke({
        oracleContract,
        requestType: 'compute',
        payloadBase64,
        callbackHash: walletCallbackHash,
        callbackMethod: walletCallbackMethod,
      })
    : '';
  const callbackQueryTemplate = buildCallbackQueryTemplate(walletCallbackHash);
  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
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
            Private Compute
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            Author JS, builtin, and WASM request packages using the same payload shapes that the
            live confidential runtime expects.
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
              color: computeStatusAccent,
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

      {oracleStateStatus.level !== 'ready' && (
        <div
          className="card-industrial"
          style={{ padding: '1.25rem 1.5rem', borderLeft: `4px solid ${readinessAccent}` }}
        >
          <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{oracleStateStatus.label}:</strong>{' '}
            {oracleStateStatus.detail}
          </p>
        </div>
      )}

      <ComputeFunctions selectedFunc={selectedFunc} onSelectPreset={applyComputePreset} />

      <ComputeEditor
        userCode={userCode}
        setUserCode={setUserCode}
        scriptRefJson={scriptRefJson}
        setScriptRefJson={setScriptRefJson}
        computeInput={computeInput}
        setComputeInput={setComputeInput}
        walletCallbackHash={walletCallbackHash}
        setWalletCallbackHash={setWalletCallbackHash}
        walletCallbackMethod={walletCallbackMethod}
        setWalletCallbackMethod={setWalletCallbackMethod}
        isSimulating={isSimulating}
        onExecute={handleExecute}
        onGeneratePackage={generateOnchainPackage}
      />

      {generatedPackage && (
        <ComputeOutput
          generatedPackage={generatedPackage}
          oracleContract={oracleContract}
          payloadBase64={payloadBase64}
          neoRpcInvoke={neoRpcInvoke}
          callbackQueryTemplate={callbackQueryTemplate}
          copiedItem={copiedItem}
          onCopy={handleCopy}
          isWalletSubmitting={isWalletSubmitting}
          onSubmitWithWallet={submitGeneratedWithWallet}
          canSubmitWithWallet={oracleSubmitReady}
          readinessLabel={packageReadiness.label}
          readinessDetail={packageReadiness.detail}
          readinessTone={packageReadiness.tone}
        />
      )}
    </div>
  );
}
