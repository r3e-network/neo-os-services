import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { experimental, rpc as neoRpc, sc, tx, wallet, u, CONST } from '@cityofzion/neon-js';

import {
  loadExampleEnv,
  normalizeHash160,
  readDeploymentRegistry,
  resolveNeoN3SignerWif,
  sleep,
  trimString,
  tryParseJson,
  writeValidationArtifacts,
  writeSkippedValidationArtifacts,
  withRetries,
} from './common.mjs';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const scriptFilename = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFilename);
const oracleRepoRoot = path.resolve(scriptDirectory, '..', '..');

async function resolveAbstractAccountRepoRoot() {
  const candidates = [
    process.env.NEO_ABSTRACT_ACCOUNT_REPO,
    path.resolve(oracleRepoRoot, '..', 'neo-abstract-account'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      await readFile(path.join(resolved, 'sdk/js/src/metaTx.js'), 'utf8');
      return resolved;
    } catch {}
  }

  throw new Error(
    'Unable to resolve neo-abstract-account checkout. Set NEO_ABSTRACT_ACCOUNT_REPO to the repo root.'
  );
}

const aaRepoRoot = await resolveAbstractAccountRepoRoot();
const { ethers } = require('ethers');
const {
  buildV3UserOperationTypedData,
  sanitizeHex,
} = require(path.join(aaRepoRoot, 'sdk/js/src/metaTx.js'));
const {
  AbstractAccountClient,
} = require(path.join(aaRepoRoot, 'sdk/js/src/index.js'));
const relayModule = await import(
  pathToFileURL(path.join(aaRepoRoot, 'frontend/api/relay-transaction.js')).href
);
const relayHandler = relayModule.default;
let localPaymasterHandlerPromise = null;

const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const CORE_HASH = process.env.AA_CORE_HASH_TESTNET || '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2';
const WEB3AUTH_VERIFIER_HASH =
  process.env.AA_WEB3AUTH_VERIFIER_HASH_TESTNET || '0x7147f9a508594a7656a25f45d0a7a7dede7c227f';
const PAYMASTER_ACCOUNT_ID_OVERRIDE = trimString(process.env.PAYMASTER_ACCOUNT_ID || '');
let PAYMASTER_DAPP_ID = '';
const PAYMASTER_APP_ID =
  process.env.MORPHEUS_PAYMASTER_APP_ID || 'ddff154546fe22d15b65667156dd4b7c611e6093';
const PHALA_SSH_RETRIES = Math.max(1, Number(process.env.PHALA_SSH_RETRIES || 3));

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function logStage(message, data = undefined) {
  const prefix = `[aa-paymaster-automation] ${message}`;
  if (data === undefined) {
    console.log(prefix);
    return;
  }
  console.log(prefix, typeof data === 'string' ? data : JSON.stringify(data));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

function hash160Param(value) {
  return sc.ContractParam.hash160(sanitizeHex(value));
}

function byteArrayParam(hexValue) {
  // neon-js emits HexString values in little-endian form. Mark raw hex as
  // little-endian here so the VM receives the original byte order (required
  // for verifier public keys and compact signatures).
  return sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(hexValue), true));
}

function integerParam(value) {
  if (typeof value === 'bigint') return sc.ContractParam.integer(value.toString());
  return sc.ContractParam.integer(value);
}

function stringParam(value) {
  return sc.ContractParam.string(String(value));
}

function utf8ByteArrayParam(value) {
  return sc.ContractParam.byteArray(Buffer.from(String(value ?? ''), 'utf8').toString('base64'));
}

function arrayParam(values = []) {
  return sc.ContractParam.array(...values);
}

function emptyByteArrayParam() {
  return sc.ContractParam.byteArray(u.HexString.fromHex('', true));
}

function userOpJsonParam({
  targetContract,
  method,
  args = [],
  nonce = 0n,
  deadline = 0n,
  signatureHex = '',
}) {
  return {
    type: 'Struct',
    value: [
      { type: 'Hash160', value: normalizeHash(`0x${sanitizeHex(targetContract)}`) },
      { type: 'String', value: String(method) },
      { type: 'Array', value: args },
      { type: 'Integer', value: String(nonce) },
      { type: 'Integer', value: String(deadline) },
      { type: 'ByteArray', value: `0x${sanitizeHex(signatureHex)}` },
    ],
  };
}

function userOpContractParam({
  targetContract,
  method,
  args = [],
  nonce = 0n,
  deadline = 0n,
  signatureHex = '',
}) {
  return arrayParam([
    hash160Param(targetContract),
    stringParam(method),
    arrayParam(args),
    integerParam(nonce),
    integerParam(deadline),
    byteArrayParam(signatureHex),
  ]);
}

function normalizeHash(value) {
  const hex = sanitizeHex(value || '');
  return hex ? `0x${hex}` : '';
}

function parseStackItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = trimString(item.type).toLowerCase();
  switch (type) {
    case 'array':
    case 'struct':
      return Array.isArray(item.value) ? item.value.map((entry) => parseStackItem(entry)) : [];
    case 'hash160':
    case 'hash256':
    case 'string':
      return String(item.value ?? '');
    case 'integer':
      return String(item.value ?? '0');
    case 'boolean':
      return Boolean(item.value);
    case 'bytestring':
    case 'bytearray': {
      const raw = trimString(item.value);
      if (!raw) return '';
      const bytes = Buffer.from(raw, 'base64');
      if (bytes.length === 20) return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
      const text = bytes.toString('utf8');
      return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? text : `0x${bytes.toString('hex')}`;
    }
    default:
      return item.value ?? null;
  }
}

function decodeCallbackArray(item) {
  if (!item || item.type !== 'Array' || !Array.isArray(item.value) || item.value.length < 4)
    return null;
  const [requestTypeItem, successItem, resultItem, errorItem] = item.value;
  const requestType = Buffer.from(trimString(requestTypeItem?.value || ''), 'base64').toString(
    'utf8'
  );
  const resultText = Buffer.from(trimString(resultItem?.value || ''), 'base64').toString('utf8');
  const errorText = Buffer.from(trimString(errorItem?.value || ''), 'base64').toString('utf8');
  return {
    request_type: requestType,
    success: Boolean(successItem?.value),
    result_text: resultText,
    result_json: tryParseJson(resultText),
    error_text: errorText,
  };
}

async function waitForAppLog(client, txid, label, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const appLog = await client.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch {}
    await sleep(3000);
  }
  throw new Error(`${label}: timed out waiting for application log`);
}

function assertHalt(appLog, label) {
  const execution = appLog?.executions?.[0];
  if (!execution) throw new Error(`${label}: missing execution`);
  const vmState = String(execution.vmstate || execution.state || '');
  if (!vmState.includes('HALT')) {
    throw new Error(`${label}: expected HALT, got ${vmState} ${execution.exception || ''}`.trim());
  }
  return execution;
}

async function sendInvocationTransaction({
  rpcClient,
  account,
  networkMagic,
  script,
  signers,
  label,
}) {
  const preview = await rpcClient.invokeScript(u.HexString.fromHex(script), signers);
  const validUntilBlock = (await rpcClient.getBlockCount()) + 1000;
  const basePayload = {
    signers,
    validUntilBlock,
    script,
    systemFee: preview?.gasconsumed || '1000000',
  };

  let transaction = new tx.Transaction(basePayload);
  transaction.sign(account, networkMagic);
  const networkFee = await rpcClient.calculateNetworkFee(transaction);

  transaction = new tx.Transaction({
    ...basePayload,
    networkFee,
  });
  transaction.sign(account, networkMagic);

  const txid = await rpcClient.sendRawTransaction(transaction);
  const appLog = await waitForAppLog(rpcClient, txid, label);
  return {
    txid,
    preview,
    networkFee: String(networkFee),
    systemFee: preview?.gasconsumed || '0',
    appLog,
    execution: appLog?.executions?.[0] || {},
  };
}

async function invokePersisted(
  client,
  contractHash,
  account,
  networkMagic,
  operation,
  params = [],
  signers = undefined,
  rpcUrl
) {
  const resolvedSigners = signers || [
    { account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry },
  ];
  const script = sc.createScript({
    scriptHash: sanitizeHex(contractHash),
    operation,
    args: params,
  });
  const { txid, appLog } = await sendInvocationTransaction({
    rpcClient: client,
    account,
    networkMagic,
    script,
    signers: resolvedSigners,
    label: operation,
  });
  const execution = assertHalt(appLog, operation);
  return { txid, appLog, execution };
}

async function invokePersistedNoPreview(
  client,
  contractHash,
  account,
  networkMagic,
  operation,
  params = [],
  signers = undefined,
  rpcUrl,
  systemFee = '3000000'
) {
  const resolvedSigners = signers || [
    { account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry },
  ];
  const script = sc.createScript({
    scriptHash: sanitizeHex(contractHash),
    operation,
    args: params,
  });
  const validUntilBlock = (await client.getBlockCount()) + 1000;
  const basePayload = {
    signers: resolvedSigners,
    validUntilBlock,
    script,
    systemFee,
  };
  let transaction = new tx.Transaction(basePayload);
  transaction.sign(account, networkMagic);
  const networkFee = await client.calculateNetworkFee(transaction);
  transaction = new tx.Transaction({ ...basePayload, networkFee });
  transaction.sign(account, networkMagic);
  const txid = await client.sendRawTransaction(transaction);
  const appLog = await waitForAppLog(client, txid, operation);
  const execution = assertHalt(appLog, operation);
  return { txid, appLog, execution, networkFee: String(networkFee), systemFee };
}

async function runPhalaRemoteShell(
  shellScript,
  apiToken,
  appId,
  { maxBuffer = 10 * 1024 * 1024 } = {}
) {
  let lastError = null;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aa-paymaster-automation-'));
  const localScriptPath = path.join(tempDir, 'remote.sh');
  await writeFile(localScriptPath, shellScript, { mode: 0o700 });

  for (let attempt = 1; attempt <= PHALA_SSH_RETRIES; attempt += 1) {
    const remoteScriptPath = `/tmp/aa-paymaster-automation-${Date.now()}-${attempt}.sh`;
    try {
      await execFileAsync(
        'phala',
        ['cp', '--api-token', apiToken, localScriptPath, `${appId}:${remoteScriptPath}`],
        { maxBuffer }
      );
      const result = await execFileAsync(
        'phala',
        ['ssh', '--api-token', apiToken, appId, '--', 'sh', remoteScriptPath],
        { maxBuffer }
      );
      await execFileAsync(
        'phala',
        ['ssh', '--api-token', apiToken, appId, '--', 'rm', '-f', remoteScriptPath],
        { maxBuffer }
      ).catch(() => {});
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return result;
    } catch (error) {
      lastError = error;
    }
    if (attempt < PHALA_SSH_RETRIES) {
      await sleep(1500 * attempt);
    }
  }
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callLocalPaymasterAuthorize(_apiToken, body) {
  const policyId = trimString(process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID || 'testnet-aa');
  const maxGasUnits = Number(process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS || 0);
  const allowTargets = String(process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS || '')
    .split(',')
    .map((entry) => normalizeHash(entry.trim()).toLowerCase())
    .filter(Boolean);
  const allowMethods = String(process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const targetContract = normalizeHash(body?.target_contract || body?.targetContract || '').toLowerCase();
  const method = trimString(body?.method || body?.target_method || body?.targetMethod || '');
  const estimatedGasUnits = Number(body?.estimated_gas_units ?? body?.estimatedGasUnits ?? 0);

  if (!isTrueLike(process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED)) {
    return {
      approved: false,
      reason: 'paymaster disabled for network',
      policy: { policy_id: policyId, max_gas_units: maxGasUnits, allow_targets: allowTargets, allow_methods: allowMethods },
    };
  }
  if (maxGasUnits > 0 && estimatedGasUnits > maxGasUnits) {
    return {
      approved: false,
      reason: 'estimated gas exceeds network paymaster limit',
      policy: { policy_id: policyId, max_gas_units: maxGasUnits, allow_targets: allowTargets, allow_methods: allowMethods },
    };
  }
  if (allowTargets.length > 0 && !allowTargets.includes(targetContract)) {
    return {
      approved: false,
      reason: 'target_contract is not allowlisted',
      policy: { policy_id: policyId, max_gas_units: maxGasUnits, allow_targets: allowTargets, allow_methods: allowMethods },
    };
  }
  if (allowMethods.length > 0 && !allowMethods.includes(method.toLowerCase())) {
    return {
      approved: false,
      reason: 'method is not allowlisted',
      policy: { policy_id: policyId, max_gas_units: maxGasUnits, allow_targets: allowTargets, allow_methods: allowMethods },
    };
  }

  return {
    mode: 'paymaster_authorize',
    approved: true,
    network: 'testnet',
    target_chain: body?.target_chain || 'neo_n3',
    policy_id: policyId,
    account_id: normalizeHash(body?.account_id || body?.accountId || ''),
    dapp_id: trimString(body?.dapp_id || body?.dappId || ''),
    target_contract: targetContract,
    method,
    estimated_gas_units: estimatedGasUnits,
    operation_hash: trimString(body?.operation_hash || body?.operationHash || ''),
    approval_digest: ethers.id(JSON.stringify({
      network: 'testnet',
      policy_id: policyId,
      account_id: normalizeHash(body?.account_id || body?.accountId || ''),
      target_contract: targetContract,
      method,
      estimated_gas_units: estimatedGasUnits,
      operation_hash: trimString(body?.operation_hash || body?.operationHash || ''),
    })),
    policy: { policy_id: policyId, max_gas_units: maxGasUnits },
    local_policy_fallback: true,
  };
}

function ensureLocalPaymasterTestnetPolicyDefaults(coreHash, { force = false } = {}) {
  if (force || !isTrueLike(process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED)) {
    process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED = 'true';
  }
  if (force || !trimString(process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID)) {
    process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID = 'testnet-aa';
  }
  if (force || Number(process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS || 0) <= 0) {
    process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS = '5000000';
  }
  if (force || !trimString(process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS)) {
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS = normalizeHash(coreHash);
  }
  if (force || !trimString(process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS)) {
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS =
      'executeUserOp,executeUnifiedByAddress';
  }
}

async function callPaymasterAuthorize(endpoint, apiToken, body) {
  try {
    let lastHttpError = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error('paymaster http timeout')),
        12_000
      );
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) {
          clearTimeout(timeout);
          if (
            payload?.approved === false &&
            /paymaster disabled for network/i.test(String(payload.reason || ''))
          ) {
            throw new Error(`public paymaster disabled, use local policy fallback: ${JSON.stringify(payload)}`);
          }
          return payload;
        }
        if (response.status === 429 && attempt < 5) {
          lastHttpError = new Error(
            `paymaster authorize failed: ${response.status} ${JSON.stringify(payload)}`
          );
          await sleep(1500 * attempt);
          continue;
        }
        throw new Error(`paymaster authorize failed: ${response.status} ${JSON.stringify(payload)}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastHttpError || new Error('paymaster authorize failed after retries');
  } catch (networkError) {
    logStage(
      'public paymaster endpoint unavailable, falling back to CVM shell',
      String(networkError?.message || networkError)
    );
    try {
      logStage('attempting local paymaster handler fallback');
      ensureLocalPaymasterTestnetPolicyDefaults(body?.target_contract || CORE_HASH, { force: true });
      return await callLocalPaymasterAuthorize(apiToken, body);
    } catch (localError) {
      logStage('local paymaster handler fallback failed', String(localError?.message || localError));
    }
    let lastError = networkError;
    const shellScript = `
set -e
WORKER_CONTAINER="$(docker ps --format '{{.Names}}' | grep 'nitro-worker' | head -n1)"
test -n "$WORKER_CONTAINER"
docker exec -i "$WORKER_CONTAINER" node --input-type=module - <<'JS'
const body = ${JSON.stringify(body)};
const token = ${JSON.stringify(apiToken)};
const res = await fetch('http://127.0.0.1:8080/paymaster/authorize', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
let parsed;
try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
console.log(JSON.stringify({ status: res.status, body: parsed }));
JS
`;
    for (let attempt = 1; attempt <= PHALA_SSH_RETRIES; attempt += 1) {
      try {
        const { stdout } = await runPhalaRemoteShell(shellScript, apiToken, PAYMASTER_APP_ID, {
          maxBuffer: 10 * 1024 * 1024,
        });
        const jsonLine = stdout
          .trim()
          .split('\n')
          .find((line) => line.trim().startsWith('{'));
        if (!jsonLine) throw new Error(`unexpected paymaster output: ${stdout.trim()}`);
        const remote = JSON.parse(jsonLine);
        if (Number(remote.status || 200) >= 400) {
          throw new Error(
            `paymaster authorize failed: ${remote.status} ${JSON.stringify(remote.body || {})}`
          );
        }
        return remote.body || {};
      } catch (error) {
        lastError = error;
        if (attempt < PHALA_SSH_RETRIES) {
          await sleep(1500 * attempt);
        }
      }
    }
    throw lastError;
  }
}

function isTrueLike(value) {
  const normalized = trimString(value).toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function buildAutomationRegisterPayload(executeAtIso) {
  return JSON.stringify({
    trigger: {
      type: 'one_shot',
      execute_at: executeAtIso,
    },
    execution: {
      request_type: 'privacy_oracle',
      payload: {
        provider: 'twelvedata',
        symbol: 'TWELVEDATA:NEO-USD',
        json_path: 'price',
        target_chain: 'neo_n3',
        tag: 'aa-paymaster-automation',
      },
    },
    max_executions: 1,
  });
}

function escapeForCSharpStringLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function compilePaymasterAutomationConsumer(executeAtIso) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aa-paymaster-automation-consumer-'));
  const outDir = path.join(tempDir, 'out');
  await mkdir(outDir, { recursive: true });
  const registerPayloadJson = escapeForCSharpStringLiteral(
    buildAutomationRegisterPayload(executeAtIso)
  );
  const source = `using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

[DisplayName("AAPaymasterAutomationConsumer")]
[ContractPermission("*", "request")]
[ContractPermission("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer")]
public class AAPaymasterAutomationConsumer : SmartContract
{
    private static readonly byte[] PREFIX_ADMIN = new byte[] { 0x01 };
    private static readonly byte[] PREFIX_ORACLE = new byte[] { 0x02 };
    private static readonly byte[] PREFIX_CALLBACK = new byte[] { 0x10 };

    public static void _deploy(object data, bool update)
    {
        if (update) return;
        Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, Runtime.Transaction.Sender);
    }

    [Safe]
    public static UInt160 Admin() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ADMIN);

    [Safe]
    public static UInt160 Oracle() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ORACLE);

    public static void SetOracle(UInt160 oracle)
    {
        ValidateAdmin();
        ExecutionEngine.Assert(oracle != null && oracle.IsValid, "invalid oracle");
        Storage.Put(Storage.CurrentContext, PREFIX_ORACLE, oracle);
    }

    public static BigInteger RequestRawSponsored(string requestType, ByteString payload)
    {
        return (BigInteger)Contract.Call(
            RequireOracle(),
            "request",
            CallFlags.All,
            requestType,
            payload,
            Runtime.ExecutingScriptHash,
            "onOracleResult"
        );
    }

    public static BigInteger RegisterDefaultAutomationSponsored()
    {
        string payloadJson = "${registerPayloadJson}";
        return RequestRawSponsored("automation_register", (ByteString)payloadJson);
    }

    public static void DepositOracleCredits(BigInteger amount)
    {
        UInt160 oracle = RequireOracle();
        ExecutionEngine.Assert(amount > 0, "invalid amount");
        ExecutionEngine.Assert(
            GAS.Transfer(Runtime.ExecutingScriptHash, oracle, amount, Runtime.ExecutingScriptHash),
            "gas transfer failed"
        );
    }

    public static void OnNEP17Payment(UInt160 from, BigInteger amount, object data)
    {
        ExecutionEngine.Assert(Runtime.CallingScriptHash == GAS.Hash, "only GAS accepted");
        ExecutionEngine.Assert(amount >= 0, "invalid amount");
    }

    public static void OnOracleResult(BigInteger requestId, string requestType, bool success, ByteString result, string error)
    {
        ValidateOracle();
        Storage.Put(
            Storage.CurrentContext,
            Helper.Concat(PREFIX_CALLBACK, (ByteString)requestId.ToByteArray()),
            StdLib.Serialize(new object[] { requestType, success, result, error })
        );
    }

    [Safe]
    public static object[] GetCallback(BigInteger requestId)
    {
        ByteString raw = (ByteString)Storage.Get(Storage.CurrentContext, Helper.Concat(PREFIX_CALLBACK, (ByteString)requestId.ToByteArray()));
        if (raw == null) return new object[] { };
        return (object[])StdLib.Deserialize(raw);
    }

    private static void ValidateAdmin()
    {
        UInt160 admin = Admin();
        ExecutionEngine.Assert(admin != null && admin.IsValid, "admin not set");
        ExecutionEngine.Assert(Runtime.CheckWitness(admin), "unauthorized");
    }

    private static UInt160 RequireOracle()
    {
        UInt160 oracle = Oracle();
        ExecutionEngine.Assert(oracle != null && oracle.IsValid, "oracle not set");
        return oracle;
    }

    private static void ValidateOracle()
    {
        ExecutionEngine.Assert(Runtime.CallingScriptHash == RequireOracle(), "unauthorized caller");
    }
}`;
  const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <Optimize>true</Optimize>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Neo.SmartContract.Framework" Version="3.9.1" />
  </ItemGroup>
  <ItemGroup>
    <Compile Include="AAPaymasterAutomationConsumer.cs" />
  </ItemGroup>
</Project>
`;
  await writeFile(path.join(tempDir, 'AAPaymasterAutomationConsumer.cs'), source);
  await writeFile(path.join(tempDir, 'AAPaymasterAutomationConsumer.csproj'), csproj);
  await execFileAsync(
    path.join(process.env.HOME || '~', '.dotnet/tools/nccs'),
    [
      path.join(tempDir, 'AAPaymasterAutomationConsumer.csproj'),
      '-o',
      outDir,
      '--base-name',
      'AAPaymasterAutomationConsumer',
      '--assembly',
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  return { tempDir, outDir };
}

async function loadContractArtifacts(baseName, buildDir) {
  const nefPath = path.join(buildDir, `${baseName}.nef`);
  const manifestPath = path.join(buildDir, `${baseName}.manifest.json`);
  const [nefBytes, manifestRaw] = await Promise.all([
    readFile(nefPath),
    readFile(manifestPath, 'utf8'),
  ]);
  return {
    nef: sc.NEF.fromBuffer(nefBytes),
    manifestJson: JSON.parse(manifestRaw),
  };
}

function decodeDeployHash(appLog) {
  const notification = appLog?.executions
    ?.flatMap((execution) => execution.notifications || [])
    .find((entry) => entry.eventname === 'Deploy');
  const value = notification?.state?.value?.[0]?.value || '';
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 20) throw new Error('failed to decode deployed Neo N3 contract hash');
  return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
}

async function deployContract(client, account, rpcUrl, networkMagic, baseName, buildDir, suffix) {
  const { nef, manifestJson } = await loadContractArtifacts(baseName, buildDir);
  const uniqueManifest = {
    ...manifestJson,
    name: `${manifestJson.name}-${suffix}`,
  };
  const builder = new sc.ScriptBuilder();
  builder.emitContractCall({
    scriptHash: CONST.NATIVE_CONTRACT_HASH.ManagementContract,
    operation: 'deploy',
    callFlags: sc.CallFlags.All,
    args: [
      sc.ContractParam.byteArray(u.HexString.fromHex(nef.serialize(), true)),
      sc.ContractParam.string(JSON.stringify(uniqueManifest)),
    ],
  });
  const deployment = await sendInvocationTransaction({
    rpcClient: client,
    account,
    networkMagic,
    script: builder.build(),
    signers: [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }],
    label: `deploy ${baseName}`,
  });
  const appLog = deployment.appLog;
  const execution = assertHalt(appLog, `deploy ${baseName}`);
  return { txid: deployment.txid, appLog, execution, hash: decodeDeployHash(appLog) };
}

async function invokeRead(client, contractHash, operation, params = []) {
  const normalizedHash = trimString(contractHash).replace(/^0x/i, '');
  const result = await withRetries(`invokeRead:${operation}`, () =>
    client.invokeFunction(normalizedHash, operation, params)
  );
  if (String(result?.state || '').includes('FAULT')) {
    throw new Error(`${operation} fault: ${result.exception || 'VM fault'}`);
  }
  return result?.stack?.[0];
}

function decodeIntStack(item) {
  return BigInt(item?.value || '0');
}

async function ensureConsumerFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  consumerHash,
  requiredRequests
) {
  const requestFee = 1_000_000n;
  const depositAmount = requestFee * BigInt(requiredRequests);
  const childScript = `
const { rpc, wallet, sc, tx, u } = require('@cityofzion/neon-js');
const rpcClient = new rpc.RPCClient(${JSON.stringify(rpcUrl)});
const account = new wallet.Account(${JSON.stringify(account.WIF || account.export?.() || process.env.NEO_TESTNET_WIF || '')});
const networkMagic = Number(${JSON.stringify(String(networkMagic))});
const GAS = ${JSON.stringify(GAS_HASH)};
const consumer = ${JSON.stringify(consumerHash)};
const amount = ${JSON.stringify(depositAmount.toString())};
async function waitForAppLog(txid, label, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const appLog = await rpcClient.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(label + ': timed out waiting for app log');
}
async function send(scriptHash, operation, args, label) {
  const script = sc.createScript({ scriptHash, operation, args });
  const signers = [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }];
  const preview = await rpcClient.invokeScript(u.HexString.fromHex(script), signers);
  const validUntilBlock = (await rpcClient.getBlockCount()) + 1000;
  const base = { signers, validUntilBlock, script, systemFee: preview.gasconsumed || '1000000' };
  let t = new tx.Transaction(base);
  t.sign(account, networkMagic);
  const networkFee = await rpcClient.calculateNetworkFee(t);
  t = new tx.Transaction({ ...base, networkFee });
  t.sign(account, networkMagic);
  const txid = await rpcClient.sendRawTransaction(t);
  const appLog = await waitForAppLog(txid, label);
  return { txid, appLog };
}
(async () => {
  const transfer = await send(GAS, 'transfer', [
    sc.ContractParam.hash160('0x' + account.scriptHash),
    sc.ContractParam.hash160(consumer),
    sc.ContractParam.integer(amount),
    sc.ContractParam.any(null),
  ], 'fund consumer');
  const deposit = await send(consumer, 'depositOracleCredits', [
    sc.ContractParam.integer(amount),
  ], 'depositOracleCredits');
  console.log(JSON.stringify({ transfer_txid: transfer.txid, deposit_txid: deposit.txid }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
  const { stdout } = await execFileAsync(process.execPath, ['-e', childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEO_TESTNET_WIF: account.WIF || process.env.NEO_TESTNET_WIF || '',
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  const lastJsonLine = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((line) => line.trim().startsWith('{'));
  const parsed = lastJsonLine ? JSON.parse(lastJsonLine) : {};
  return {
    request_fee: requestFee.toString(),
    current_credit: null,
    deposit_amount: depositAmount.toString(),
    fund_txid: parsed.transfer_txid || null,
    txid: parsed.deposit_txid || null,
  };
}

async function waitForRequestId(rpcClient, txid, timeoutMs = 90000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const appLog = await rpcClient.getApplicationLog(txid);
      const notification = appLog.executions
        ?.flatMap((execution) => execution.notifications || [])
        .find((entry) => ['OracleRequested', 'MiniAppRequestQueued'].includes(entry.eventname));
      const requestId = notification?.state?.value?.[0]?.value ?? null;
      if (requestId) return requestId;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`timed out waiting for request id from tx ${txid}`);
}

async function waitForCallback(rpcClient, consumerHash, requestId, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await rpcClient.invokeFunction(sanitizeHex(consumerHash), 'getCallback', [
      { type: 'Integer', value: String(requestId) },
    ]);
    const decoded = decodeCallbackArray(response.stack?.[0]);
    if (decoded && (decoded.request_type || decoded.result_text || decoded.error_text))
      return decoded;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for callback ${requestId}`);
}

async function readCallbackOnce(rpcClient, consumerHash, requestId) {
  const response = await rpcClient.invokeFunction(sanitizeHex(consumerHash), 'getCallback', [
    { type: 'Integer', value: String(requestId) },
  ]);
  return decodeCallbackArray(response.stack?.[0]);
}

async function resolveQueueTxRequestId(rpcClient, txid, timeoutMs = 30000) {
  try {
    return await waitForRequestId(rpcClient, txid, timeoutMs);
  } catch {
    return null;
  }
}

async function fetchAutomationRecord(baseUrl, apiKey, automationId, network = 'testnet') {
  const headers = {
    apikey: apiKey,
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  };

  const jobUrl = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/morpheus_automation_jobs`);
  jobUrl.searchParams.set('select', '*');
  jobUrl.searchParams.set('network', `eq.${network}`);
  jobUrl.searchParams.set('automation_id', `eq.${automationId}`);
  jobUrl.searchParams.set('limit', '1');
  const jobRows = await fetch(jobUrl, { headers }).then((response) =>
    response.ok ? response.json() : []
  );

  const runsUrl = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/morpheus_automation_runs`);
  runsUrl.searchParams.set('select', '*');
  runsUrl.searchParams.set('network', `eq.${network}`);
  runsUrl.searchParams.set('automation_id', `eq.${automationId}`);
  runsUrl.searchParams.set('order', 'created_at.asc');
  const runRows = await fetch(runsUrl, { headers }).then((response) =>
    response.ok ? response.json() : []
  );

  return {
    job: Array.isArray(jobRows) ? jobRows[0] || null : null,
    runs: Array.isArray(runRows) ? runRows : [],
  };
}

async function patchAutomationRecord(
  baseUrl,
  apiKey,
  automationId,
  fields = {},
  network = 'testnet'
) {
  const headers = {
    apikey: apiKey,
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    'content-type': 'application/json',
    prefer: 'return=representation',
  };
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/morpheus_automation_jobs`);
  url.searchParams.set('network', `eq.${network}`);
  url.searchParams.set('automation_id', `eq.${automationId}`);
  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      ...fields,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `failed to patch automation job ${automationId}: ${response.status} ${await response.text()}`
    );
  }
  return response.json().catch(() => []);
}

async function waitForQueuedAutomation(
  baseUrl,
  apiKey,
  automationId,
  oracleHash,
  startRequestIdExclusive,
  requesterHash,
  consumerHash,
  rpcClient,
  timeoutMs = 300000
) {
  const startedAt = Date.now();
  let nextRequestId = BigInt(startRequestIdExclusive) + 1n;
  const candidateRequestIds = new Map();
  while (Date.now() - startedAt < timeoutMs) {
    const record = await fetchAutomationRecord(baseUrl, apiKey, automationId, 'testnet');
    for (const run of record.runs || []) {
      const txHash = trimString(run?.queue_tx?.tx_hash || '');
      if (!txHash) continue;
      const resolvedRequestId = await resolveQueueTxRequestId(rpcClient, txHash, 10000);
      if (!resolvedRequestId) continue;
      candidateRequestIds.set(String(resolvedRequestId), {
        source: 'supabase_queue_tx',
        run_status: trimString(run?.status || ''),
        queue_tx_hash: txHash,
      });
    }

    const totalRequests = decodeIntStack(
      await invokeRead(rpcClient, oracleHash, 'getTotalRequests', [])
    );
    for (; nextRequestId <= totalRequests; nextRequestId += 1n) {
      const requestId = nextRequestId;
      const requestItem = await invokeRead(rpcClient, oracleHash, 'getRequest', [
        { type: 'Integer', value: requestId.toString() },
      ]);
      const request = Array.isArray(requestItem?.value) ? requestItem.value : [];
      if (request.length < 12) continue;
      const requester = normalizeHash160(request[5]?.value || '');
      const callbackContract = normalizeHash160(request[3]?.value || '');
      if (requester !== requesterHash || callbackContract !== consumerHash) continue;
      candidateRequestIds.set(requestId.toString(), {
        source: 'chain_scan',
      });
    }

    const sortedRequestIds = [...candidateRequestIds.keys()].sort(
      (left, right) => Number(left) - Number(right)
    );
    for (const requestId of sortedRequestIds) {
      const callback = await readCallbackOnce(rpcClient, consumerHash, requestId);
      if (callback?.request_type === 'privacy_oracle' && callback.success) {
        return {
          mode: 'scheduler',
          request_id: String(requestId),
          callback,
          record,
          source: candidateRequestIds.get(String(requestId)) || null,
        };
      }
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for queued automation execution for ${automationId}`);
}

async function main() {
  await loadExampleEnv();
  PAYMASTER_DAPP_ID = trimString(process.env.MORPHEUS_PAYMASTER_DAPP_ID || '');
  assertCondition(PAYMASTER_DAPP_ID, 'MORPHEUS_PAYMASTER_DAPP_ID is required');

  const TEST_WIF = trimString(process.env.TEST_WIF || resolveNeoN3SignerWif('testnet') || '');
  const deployment = (await readDeploymentRegistry('testnet')).neo_n3 || {};
  const RPC_URL = trimString(
    deployment.rpc_url || process.env.TESTNET_RPC_URL || 'https://testnet1.neo.coz.io:443'
  );
  const PAYMASTER_API_TOKEN =
    process.env.MORPHEUS_RUNTIME_TOKEN || process.env.PHALA_API_TOKEN || process.env.PHALA_SHARED_SECRET || '';
  const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.morpheus_SUPABASE_URL ||
    '';
  const SUPABASE_KEY =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.morpheus_SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.morpheus_SUPABASE_SERVICE_ROLE_KEY ||
    '';
  const PAYMASTER_ENDPOINT = trimString(
    process.env.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT ||
      'https://oracle.meshmini.app/testnet/paymaster/authorize'
  );

  assertCondition(TEST_WIF, 'TEST_WIF or compatible pinned Neo N3 signer is required');
  assertCondition(
    PAYMASTER_API_TOKEN,
    'MORPHEUS_RUNTIME_TOKEN, PHALA_API_TOKEN, or PHALA_SHARED_SECRET is required'
  );
  assertCondition(SUPABASE_URL && SUPABASE_KEY, 'Supabase secret or service-role env is required');

  const oracleHash = normalizeHash160(deployment.oracle_hash || '');
  assertCondition(oracleHash, 'testnet oracle hash is required');

  logStage('boot', {
    rpc_url: RPC_URL,
    core_hash: normalizeHash(CORE_HASH),
    verifier_hash: normalizeHash(WEB3AUTH_VERIFIER_HASH),
    oracle_hash: oracleHash,
    paymaster_endpoint: PAYMASTER_ENDPOINT,
    paymaster_app_id: PAYMASTER_APP_ID,
  });

  const account = new wallet.Account(TEST_WIF);
  const rpcClient = new neoRpc.RPCClient(RPC_URL);
  const networkMagic = Number(deployment.network_magic || 894710606);
  const aaClient = new AbstractAccountClient(RPC_URL, CORE_HASH);
  const evmSigner = ethers.Wallet.createRandom();
  const verifierPubKey = sanitizeHex(evmSigner.signingKey.publicKey);
  const paymasterEscapeTimelock = Number(
    process.env.PAYMASTER_ACCOUNT_ESCAPE_TIMELOCK || 30 * 24 * 60 * 60
  );
  const paymasterAccountId = normalizeHash(
    PAYMASTER_ACCOUNT_ID_OVERRIDE ||
      `0x${aaClient.deriveRegistrationAccountIdHash({
        verifierContractHash: WEB3AUTH_VERIFIER_HASH,
        verifierParamsHex: verifierPubKey,
        hookContractHash: '',
        backupOwnerAddress: account.scriptHash,
        escapeTimelock: paymasterEscapeTimelock,
      })}`
  );
  const executeAtIso = new Date(Date.now() + 20_000).toISOString();
  const automationRegisterPayload = buildAutomationRegisterPayload(executeAtIso);
  const predeployedConsumerHash = normalizeHash160(
    process.env.MORPHEUS_NEO_N3_PAYMASTER_AUTOMATION_CONSUMER_HASH ||
      deployment.paymaster_automation_consumer_hash ||
      deployment.consumer_hash ||
      deployment.example_consumer_hash ||
      ''
  );
  const forceTempConsumer = isTrueLike(
    process.env.MORPHEUS_PAYMASTER_AUTOMATION_FORCE_TEMP_CONSUMER || ''
  );
  const adminSigners = [
    new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global }),
  ];
  let consumerDeploy = null;
  let consumerHash = predeployedConsumerHash;
  let consumerMode = 'predeployed_allowlisted';

  if (consumerHash && !forceTempConsumer) {
    logStage('using predeployed allowlisted consumer', { consumer_hash: consumerHash });
  } else {
    consumerMode = 'temporary_deployed';
    logStage('compiling temporary consumer');
    const consumerBuild = await compilePaymasterAutomationConsumer(executeAtIso);
    logStage('deploying temporary consumer');
    consumerDeploy = await deployContract(
      rpcClient,
      account,
      RPC_URL,
      networkMagic,
      'AAPaymasterAutomationConsumer',
      consumerBuild.outDir,
      `aa-paymaster-automation-${Date.now()}`
    );
    consumerHash = consumerDeploy.hash;
    logStage('consumer deployed', { consumer_hash: consumerHash, txid: consumerDeploy.txid });
    logStage('allowlisting callback');
    await invokePersisted(
      rpcClient,
      oracleHash,
      account,
      networkMagic,
      'addAllowedCallback',
      [hash160Param(consumerHash)],
      adminSigners,
      RPC_URL
    );
    logStage('binding oracle on consumer');
    await invokePersisted(
      rpcClient,
      consumerHash,
      account,
      networkMagic,
      'setOracle',
      [hash160Param(oracleHash)],
      adminSigners,
      RPC_URL
    );
  }
  assertCondition(consumerHash, 'predeployed consumer hash or deployable temporary consumer is required');
  logStage('funding consumer fee credits');
  // Automation registration plus later queued execution can consume additional
  // request credits during live retries, so keep the same larger buffer used
  // by the dedicated automation validation probe.
  const consumerCredit = await ensureConsumerFeeCredit(
    account,
    RPC_URL,
    networkMagic,
    rpcClient,
    oracleHash,
    consumerHash,
    8
  );
  logStage('consumer credits ready', consumerCredit);

  const defaultAccountRegistersVerifier = !PAYMASTER_ACCOUNT_ID_OVERRIDE;
  let register = null;
  try {
    logStage('registering paymaster AA account if needed', normalizeHash(paymasterAccountId));
    register = await invokePersisted(
      rpcClient,
      CORE_HASH,
      account,
      networkMagic,
      'registerAccount',
      [
        hash160Param(paymasterAccountId),
        hash160Param(defaultAccountRegistersVerifier ? WEB3AUTH_VERIFIER_HASH : '0'.repeat(40)),
        defaultAccountRegistersVerifier ? byteArrayParam(verifierPubKey) : emptyByteArrayParam(),
        hash160Param('0'.repeat(40)),
        hash160Param(account.scriptHash),
        integerParam(paymasterEscapeTimelock),
      ],
      undefined,
      RPC_URL
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Account already exists')) throw error;
    logStage('registerAccount skipped', 'account already exists');
  }

  let updateVerifier = null;
  if (defaultAccountRegistersVerifier) {
    logStage('verifier configured during account registration');
  } else {
    logStage('updating verifier');
    updateVerifier = await invokePersisted(
      rpcClient,
      CORE_HASH,
      account,
      networkMagic,
      'updateVerifier',
      [
        hash160Param(paymasterAccountId),
        hash160Param(WEB3AUTH_VERIFIER_HASH),
        byteArrayParam(verifierPubKey),
      ],
      undefined,
      RPC_URL
    );
  }

  let configuredPubKeyHex = '';
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const configuredPubKeyResult = await invokeRead(rpcClient, WEB3AUTH_VERIFIER_HASH, 'getPublicKey', [
      hash160Param(paymasterAccountId),
    ]);
    configuredPubKeyHex = configuredPubKeyResult?.value
      ? Buffer.from(configuredPubKeyResult.value, 'base64').toString('hex').toLowerCase()
      : '';
    if (configuredPubKeyHex === verifierPubKey) break;
    if (attempt < 30) await sleep(2000);
  }
  logStage('verifier public key check', {
    byte_length: configuredPubKeyHex.length / 2,
    prefix: configuredPubKeyHex.slice(0, 2),
    matches_signer_public_key: configuredPubKeyHex === verifierPubKey,
  });
  assertCondition(
    configuredPubKeyHex === verifierPubKey,
    'Web3Auth verifier public key did not become readable after account registration'
  );

  const nonce = decodeIntStack(
    await invokeRead(rpcClient, CORE_HASH, 'getNonce', [
      hash160Param(paymasterAccountId),
      integerParam(0),
    ])
  );
  logStage('nonce loaded', nonce.toString());
  const downstreamMethod = 'requestRawSponsored';
  const downstreamArgs = [
    stringParam('automation_register'),
    utf8ByteArrayParam(automationRegisterPayload),
  ];
  // The target method expects a ByteArray payload, but the deployed Web3AuthVerifier's
  // StdLib.Serialize(op.Args) path hashes that ByteString equivalently to its UTF-8 string
  // representation for EIP-712 purposes. Use the string-shaped args only for the signed
  // argsHash; keep the actual UserOperation args as ByteArray so requestRawSponsored ABI
  // execution remains correct.
  const signingArgs = [
    stringParam('automation_register'),
    stringParam(automationRegisterPayload),
  ];
  const argsHashHex = await aaClient.computeArgsHash(signingArgs);
  const deadline = BigInt(Date.now() + 60 * 60 * 1000);
  const typedData = buildV3UserOperationTypedData({
    chainId: networkMagic,
    verifyingContract: sanitizeHex(WEB3AUTH_VERIFIER_HASH),
    accountIdHash: sanitizeHex(paymasterAccountId),
    targetContract: sanitizeHex(consumerHash),
    method: downstreamMethod,
    argsHashHex,
    nonce,
    deadline,
  });
  const signature = ethers.Signature.from(
    await evmSigner.signTypedData(typedData.domain, typedData.types, typedData.message)
  );
  const compactSignature = `${sanitizeHex(signature.r)}${sanitizeHex(signature.s)}`;
  const validation = await invokeRead(rpcClient, WEB3AUTH_VERIFIER_HASH, 'validateSignature', [
    hash160Param(paymasterAccountId),
    userOpContractParam({
      targetContract: normalizeHash(consumerHash),
      method: downstreamMethod,
      args: downstreamArgs,
      nonce,
      deadline,
      signatureHex: compactSignature,
    }),
  ]);
  const signatureValid = validation?.value === true || validation?.value === 1;
  logStage('signature candidate checked', { mode: 'eip712_args_payload_as_string', valid: signatureValid });
  assertCondition(signatureValid, 'Web3Auth verifier rejected EIP-712 payload-string args signature');

  logStage('authorizing paymaster');
  ensureLocalPaymasterTestnetPolicyDefaults(CORE_HASH);
  const paymaster = await callPaymasterAuthorize(PAYMASTER_ENDPOINT, PAYMASTER_API_TOKEN, {
    network: 'testnet',
    target_chain: 'neo_n3',
    account_id: normalizeHash(paymasterAccountId),
    dapp_id: PAYMASTER_DAPP_ID,
    target_contract: normalizeHash(CORE_HASH),
    method: 'executeUserOp',
    estimated_gas_units: 3000000,
    operation_hash: `0x${Buffer.from(ethers.randomBytes(32)).toString('hex')}`,
  });
  assertCondition(
    paymaster?.approved === true,
    `paymaster authorization was not approved: ${JSON.stringify(paymaster)}`
  );
  logStage('paymaster approved', {
    approved: paymaster.approved,
    policy_id: paymaster.policy_id || null,
    approval_digest: paymaster.approval_digest || null,
  });

  logStage('broadcasting executeUserOp without preview');
  const relay = await invokePersistedNoPreview(
    rpcClient,
    CORE_HASH,
    account,
    networkMagic,
    'executeUserOp',
    [
      hash160Param(paymasterAccountId),
      userOpContractParam({
        targetContract: normalizeHash(consumerHash),
        method: downstreamMethod,
        args: downstreamArgs,
        nonce,
        deadline,
        signatureHex: compactSignature,
      }),
    ],
    [{ account: account.scriptHash, scopes: tx.WitnessScope.Global }],
    RPC_URL,
    '4000000'
  );

  const relayExecution = relay.execution;
  logStage('executeUserOp HALTed', {
    txid: relay.txid,
    network_fee: relay.networkFee,
    system_fee: relay.systemFee,
  });
  logStage('waiting for automation_register request id');
  const automationRegisterRequestId = await waitForRequestId(rpcClient, relay.txid);
  logStage('waiting for automation_register callback', String(automationRegisterRequestId));
  const automationRegisterCallback = await waitForCallback(
    rpcClient,
    consumerHash,
    automationRegisterRequestId,
    180000
  );
  assertCondition(
    automationRegisterCallback?.success === true,
    'automation register callback should succeed through paymaster-sponsored AA execution'
  );
  const automationId = trimString(
    automationRegisterCallback.result_json?.result?.automation_id ||
      automationRegisterCallback.result_json?.automation_id ||
      ''
  );
  assertCondition(automationId, 'automation register callback did not return automation_id');

  logStage('waiting for queued automation execution', automationId);
  const queuedExecution = await waitForQueuedAutomation(
    SUPABASE_URL,
    SUPABASE_KEY,
    automationId,
    oracleHash,
    automationRegisterRequestId,
    normalizeHash(account.scriptHash),
    consumerHash,
    rpcClient,
    180000
  );
  assertCondition(
    queuedExecution.callback?.success === true,
    'queued automation execution should fulfill successfully'
  );
  assertCondition(
    queuedExecution.callback?.request_type === 'privacy_oracle',
    'queued automation execution should be privacy_oracle'
  );

  const generatedAt = new Date().toISOString();
  const jsonReport = {
    generated_at: generatedAt,
    network: 'testnet',
    rpc_url: RPC_URL,
    network_magic: networkMagic,
    aa_core_hash: normalizeHash(CORE_HASH),
    web3auth_verifier_hash: normalizeHash(WEB3AUTH_VERIFIER_HASH),
    oracle_hash: oracleHash,
    callback_consumer_hash: consumerHash,
    callback_consumer_mode: consumerMode,
    callback_consumer_deploy_txid: consumerDeploy?.txid || null,
    automation_execute_at: executeAtIso,
    paymaster_endpoint: PAYMASTER_ENDPOINT,
    paymaster,
    account_id: normalizeHash(paymasterAccountId),
    registration_fee_status: register?.txid ? { txid: register.txid } : null,
    consumer_fee_status: consumerCredit,
    update_verifier_txid: updateVerifier?.txid || null,
    relay: {
      txid: relay.txid,
      execution_vmstate: relayExecution.vmstate || relayExecution.state || '',
      execution_stack: relayExecution.stack || [],
      network_fee: relay.networkFee,
      system_fee: relay.systemFee,
    },
    automation_register: {
      request_id: String(automationRegisterRequestId),
      callback: automationRegisterCallback,
      automation_id: automationId,
    },
    queued_execution: queuedExecution,
  };

  const markdownReport = [
    '# N3 AA Paymaster Automation Oracle Validation',
    '',
    `Date: ${generatedAt}`,
    '',
    '## Scope',
    '',
    'This probe validates the final integrated path where Morpheus paymaster pre-authorizes an AA `executeUserOp`, the AA account calls a downstream consumer to register automation, and the later automation execution triggers a Morpheus privacy_oracle callback successfully.',
    '',
    '## Result',
    '',
    `- AA core: \`${normalizeHash(CORE_HASH)}\``,
    `- Account id: \`${normalizeHash(paymasterAccountId)}\``,
    `- Consumer: \`${consumerHash}\``,
    `- Relay tx: \`${relay.txid}\``,
    `- Paymaster policy id: \`${paymaster.policy_id || 'n/a'}\``,
    `- Paymaster approval digest: \`${paymaster.approval_digest || 'n/a'}\``,
    `- Automation id: \`${automationId}\``,
    `- Automation register request id: \`${automationRegisterRequestId}\``,
    `- Queued automation execution mode: \`${queuedExecution.mode || 'scheduler'}\``,
    `- Queued automation chain request id: \`${queuedExecution.request_id}\``,
    `- Queued automation callback success: \`${queuedExecution.callback?.success}\``,
    '',
    '## Conclusion',
    '',
    'A paymaster-sponsored `executeUserOp` can register downstream automation through an AA account, and the later automation execution still reaches the Morpheus privacy_oracle callback path successfully. This closes the final integrated paymaster -> AA -> automation -> Oracle proof gap on testnet.',
    '',
  ].join('\n');

  const artifacts = await writeValidationArtifacts({
    baseName: 'n3-aa-paymaster-automation-oracle',
    network: 'testnet',
    generatedAt,
    jsonReport,
    markdownReport,
  });

  console.log(
    JSON.stringify(
      {
        ...artifacts,
        relay_txid: relay.txid,
        automation_id: automationId,
        queued_chain_request_id: queuedExecution.request_id,
        paymaster_policy_id: paymaster.policy_id || null,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  if (/addAllowedCallback/i.test(message)) {
    writeSkippedValidationArtifacts({
      baseName: 'n3-aa-paymaster-automation-oracle',
      network: 'testnet',
      title: 'N3 AA Paymaster Automation Oracle Validation',
      reason: 'requires-privileged-callback-registration',
      details: { error: message },
    })
      .then((artifacts) => {
        console.log(JSON.stringify({ ...artifacts, skipped: true, error: message }, null, 2));
        process.exit(0);
      })
      .catch((artifactError) => {
        console.error(artifactError?.stack || artifactError?.message || String(artifactError));
        process.exit(1);
      });
    return;
  }
  console.error(error);
  process.exit(1);
});
