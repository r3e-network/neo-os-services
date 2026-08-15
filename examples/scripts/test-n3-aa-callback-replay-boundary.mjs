import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { experimental, rpc as neoRpc, sc, tx, u, wallet } from '@cityofzion/neon-js';
import { buildFulfillmentDigestBytes } from '../../workers/morpheus-relayer/src/router.js';
import {
  jsonPretty,
  loadExampleEnv,
  normalizeHash160,
  readDeploymentRegistry,
  repoRoot,
  resolveNeoN3SignerWif,
  sleep,
  trimString,
  tryParseJson,
  writeValidationArtifacts,
  writeSkippedValidationArtifacts,
  withRetries,
} from './common.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const CONTRACT_BUILD_DIR = path.resolve(repoRoot, 'contracts/build');
const AA_BUILD_DIR = path.resolve(repoRoot, '../neo-abstract-account/contracts/bin/v3');
const SOURCE_CALLBACK_REPORT = path.resolve(
  repoRoot,
  'examples/deployments/n3-privacy-validation.testnet.latest.json'
);
const execFileAsync = promisify(execFile);
const MIN_ESCAPE_TIMELOCK_SECONDS = '604800';

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
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

function byteArrayParam(hexValue) {
  return sc.ContractParam.byteArray(
    u.HexString.fromHex(String(hexValue || '').replace(/^0x/i, ''), true)
  );
}

async function invokeRead(rpcClient, contractHash, method, params = []) {
  const response = await withRetries(`invokeRead:${method}`, () =>
    rpcClient.invokeFunction(contractHash, method, params)
  );
  if (String(response.state || '').toUpperCase() === 'FAULT') {
    throw new Error(`${method} faulted: ${response.exception || 'unknown error'}`);
  }
  return parseStackItem(response.stack?.[0]);
}

async function waitForApplicationLog(rpcClient, txHash, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await rpcClient.getApplicationLog(txHash);
    } catch {}
    await sleep(2000);
  }
  throw new Error(`timed out waiting for application log ${txHash}`);
}

function assertHalt(appLog, label) {
  const execution = appLog?.executions?.[0];
  const vmState = String(execution?.vmstate || execution?.state || '');
  if (!vmState.includes('HALT')) {
    throw new Error(`${label} did not HALT: ${vmState} ${execution?.exception || ''}`.trim());
  }
  return execution;
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

async function loadContractArtifacts(baseName, buildDir) {
  const nefPath = path.join(buildDir, `${baseName}.nef`);
  const manifestPath = path.join(buildDir, `${baseName}.manifest.json`);
  const [nefBytes, manifestRaw] = await Promise.all([
    fs.readFile(nefPath),
    fs.readFile(manifestPath, 'utf8'),
  ]);
  const manifestJson = JSON.parse(manifestRaw);
  return {
    nef: sc.NEF.fromBuffer(nefBytes),
    manifestJson,
  };
}

async function deployContract(
  rpcClient,
  account,
  rpcUrl,
  networkMagic,
  baseName,
  buildDir,
  suffix
) {
  const { nef, manifestJson } = await loadContractArtifacts(baseName, buildDir);
  const uniqueManifest = sc.ContractManifest.fromJson({
    ...manifestJson,
    name: `${manifestJson.name}-${suffix}`,
  });
  const txid = await experimental.deployContract(nef, uniqueManifest, {
    account,
    rpcAddress: rpcUrl,
    networkMagic,
    blocksTillExpiry: 200,
  });
  const appLog = await waitForApplicationLog(rpcClient, txid);
  assertHalt(appLog, `deploy ${baseName}`);
  return {
    txid,
    hash: decodeDeployHash(appLog),
  };
}

async function compileReplayHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aa-bound-replay-harness-'));
  const outDir = path.join(tempDir, 'out');
  await fs.mkdir(outDir, { recursive: true });

  const source = `using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

[DisplayName("AABoundOracleReplayHarness")]
[ContractPermission("*", "request")]
public class AABoundOracleReplayHarness : SmartContract
{
    private static readonly byte[] PREFIX_ADMIN = new byte[] { 0x01 };
    private static readonly byte[] PREFIX_ORACLE = new byte[] { 0x02 };
    private static readonly byte[] PREFIX_AA_CORE = new byte[] { 0x03 };
    private static readonly byte[] PREFIX_PENDING = new byte[] { 0x10 };
    private static readonly byte[] PREFIX_UNLOCKED = new byte[] { 0x11 };
    private static readonly byte[] PREFIX_CALLBACK = new byte[] { 0x12 };

    public static void _deploy(object data, bool update)
    {
        if (update) return;
        Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, Runtime.Transaction.Sender);
    }

    [Safe]
    public static UInt160 Admin() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ADMIN);

    [Safe]
    public static UInt160 Oracle() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ORACLE);

    [Safe]
    public static UInt160 AaCore() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_AA_CORE);

    public static void SetOracle(UInt160 oracle)
    {
        ValidateAdmin();
        ExecutionEngine.Assert(oracle != null && oracle.IsValid, "invalid oracle");
        Storage.Put(Storage.CurrentContext, PREFIX_ORACLE, oracle);
    }

    public static void SetAaCore(UInt160 aaCore)
    {
        ValidateAdmin();
        ExecutionEngine.Assert(aaCore != null && aaCore.IsValid, "invalid aa core");
        Storage.Put(Storage.CurrentContext, PREFIX_AA_CORE, aaCore);
    }

    public static BigInteger BeginBoundRequest(UInt160 accountId, string tag)
    {
        RequireRegisteredAccount(accountId);
        string payloadJson = "{\\"provider\\":\\"twelvedata\\",\\"symbol\\":\\"NEO-USD\\",\\"json_path\\":\\"price\\",\\"target_chain\\":\\"neo_n3\\",\\"tag\\":\\"" + tag + "\\"}";
        BigInteger requestId = (BigInteger)Contract.Call(
            RequireOracle(),
            "request",
            CallFlags.All,
            "privacy_oracle",
            (ByteString)payloadJson,
            Runtime.ExecutingScriptHash,
            "onOracleResult"
        );
        Storage.Put(Storage.CurrentContext, Helper.Concat(PREFIX_PENDING, (ByteString)requestId.ToByteArray()), accountId);
        return requestId;
    }

    public static void OnOracleResult(BigInteger requestId, string requestType, bool success, ByteString result, string error)
    {
        ValidateOracle();
        ByteString key = (ByteString)Helper.Concat(PREFIX_PENDING, (ByteString)requestId.ToByteArray());
        UInt160 accountId = (UInt160)Storage.Get(Storage.CurrentContext, key);
        ExecutionEngine.Assert(accountId != null && accountId.IsValid, "pending account missing");
        RequireRegisteredAccount(accountId);
        if (success)
        {
            Storage.Put(Storage.CurrentContext, Helper.Concat(PREFIX_UNLOCKED, accountId), 1);
        }
        Storage.Delete(Storage.CurrentContext, key);
        Storage.Put(
            Storage.CurrentContext,
            Helper.Concat(PREFIX_CALLBACK, (ByteString)requestId.ToByteArray()),
            StdLib.Serialize(new object[] { requestType, success, result, error, accountId })
        );
    }

    [Safe]
    public static bool IsUnlocked(UInt160 accountId)
    {
        return (BigInteger)Storage.Get(Storage.CurrentContext, Helper.Concat(PREFIX_UNLOCKED, accountId)) == 1;
    }

    [Safe]
    public static object[] GetCallback(BigInteger requestId)
    {
        ByteString raw = (ByteString)Storage.Get(Storage.CurrentContext, Helper.Concat(PREFIX_CALLBACK, (ByteString)requestId.ToByteArray()));
        if (raw == null) return new object[] { };
        return (object[])StdLib.Deserialize(raw);
    }

    [Safe]
    public static UInt160 GetPendingAccount(BigInteger requestId)
    {
        return (UInt160)Storage.Get(Storage.CurrentContext, Helper.Concat(PREFIX_PENDING, (ByteString)requestId.ToByteArray()));
    }

    private static void RequireRegisteredAccount(UInt160 accountId)
    {
        UInt160 verifier = (UInt160)Contract.Call(AaCore(), "getVerifier", CallFlags.ReadOnly, accountId);
        ExecutionEngine.Assert(verifier != null && verifier.IsValid, "aa account not registered");
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
    <Compile Include="AABoundOracleReplayHarness.cs" />
  </ItemGroup>
</Project>
`;

  await fs.writeFile(path.join(tempDir, 'AABoundOracleReplayHarness.cs'), source);
  await fs.writeFile(path.join(tempDir, 'AABoundOracleReplayHarness.csproj'), csproj);
  await execFileAsync(
    path.join(process.env.HOME || '~', '.dotnet/tools/nccs'),
    [
      path.join(tempDir, 'AABoundOracleReplayHarness.csproj'),
      '-o',
      outDir,
      '--base-name',
      'AABoundOracleReplayHarness',
      '--assembly',
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  return { tempDir, outDir };
}

async function ensureRequestFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  requiredRequests
) {
  const currentCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: `0x${account.scriptHash}` },
    ])) || '0'
  );
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  const requiredCredit = requestFee * BigInt(requiredRequests);
  if (requestFee <= 0n || currentCredit >= requiredCredit) {
    return {
      request_fee: requestFee.toString(),
      current_credit: currentCredit.toString(),
      deposit_amount: '0',
    };
  }

  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const deficit = requiredCredit - currentCredit;
  await gas.invoke('transfer', [
    sc.ContractParam.hash160(`0x${account.scriptHash}`),
    sc.ContractParam.hash160(oracleHash),
    sc.ContractParam.integer(deficit.toString()),
    sc.ContractParam.any(null),
  ]);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const updatedCredit = BigInt(
      (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
        { type: 'Hash160', value: `0x${account.scriptHash}` },
      ])) || '0'
    );
    if (updatedCredit >= requiredCredit) {
      return {
        request_fee: requestFee.toString(),
        current_credit: updatedCredit.toString(),
        deposit_amount: deficit.toString(),
      };
    }
    await sleep(2000);
  }

  throw new Error('timed out waiting for request fee credit');
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
    const response = await rpcClient.invokeFunction(consumerHash, 'getCallback', [
      { type: 'Integer', value: String(requestId) },
    ]);
    const decoded = decodeCallbackArray(response.stack?.[0]);
    if (decoded && (decoded.request_type || decoded.result_text || decoded.error_text)) {
      return decoded;
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for callback ${requestId}`);
}

async function sendInvocationTransaction({ rpcClient, account, networkMagic, script, signers }) {
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
  const appLog = await waitForApplicationLog(rpcClient, txid);
  return {
    txid,
    preview,
    networkFee: String(networkFee),
    systemFee: preview?.gasconsumed || '0',
    execution: appLog?.executions?.[0] || {},
  };
}

async function main() {
  await loadExampleEnv();
  const deployment = (await readDeploymentRegistry('testnet')).neo_n3 || {};
  const rpcUrl = trimString(
    deployment.rpc_url || process.env.NEO_RPC_URL || 'https://testnet1.neo.coz.io:443'
  );
  const networkMagic = Number(
    deployment.network_magic || process.env.NEO_NETWORK_MAGIC || 894710606
  );
  const signerWif = resolveNeoN3SignerWif('testnet');
  assertCondition(signerWif, 'testnet signer WIF is required');

  const account = new wallet.Account(signerWif);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);
  const suffix = `aa-callback-replay-${Date.now()}`;

  const oracle = await deployContract(
    rpcClient,
    account,
    rpcUrl,
    networkMagic,
    'MorpheusOracle',
    CONTRACT_BUILD_DIR,
    suffix
  );
  const aaCore = await deployContract(
    rpcClient,
    account,
    rpcUrl,
    networkMagic,
    'UnifiedSmartWalletV3',
    AA_BUILD_DIR,
    suffix
  );
  const sessionVerifier = await deployContract(
    rpcClient,
    account,
    rpcUrl,
    networkMagic,
    'SessionKeyVerifier',
    AA_BUILD_DIR,
    suffix
  );
  const harnessBuild = await compileReplayHarness();
  const harness = await deployContract(
    rpcClient,
    account,
    rpcUrl,
    networkMagic,
    'AABoundOracleReplayHarness',
    harnessBuild.outDir,
    suffix
  );

  const oracleContract = new experimental.SmartContract(oracle.hash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const harnessContract = new experimental.SmartContract(harness.hash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const coreContract = new experimental.SmartContract(aaCore.hash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];

  const setUpdaterTxid = await oracleContract.invoke(
    'setUpdater',
    [sc.ContractParam.hash160(`0x${account.scriptHash}`)],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, setUpdaterTxid), 'setUpdater');
  const setVerifierTxid = await oracleContract.invoke(
    'setOracleVerificationPublicKey',
    [sc.ContractParam.publicKey(account.publicKey)],
    signers
  );
  assertHalt(
    await waitForApplicationLog(rpcClient, setVerifierTxid),
    'setOracleVerificationPublicKey'
  );
  const appId = `aa_callback_${suffix}`;
  const registerMiniAppTxid = await oracleContract.invoke(
    'registerMiniApp',
    [
      sc.ContractParam.string(appId),
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.hash160(harness.hash),
      sc.ContractParam.string('morpheus://validation/aa-callback-replay'),
      sc.ContractParam.string(''),
    ],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, registerMiniAppTxid), 'registerMiniApp');
  const grantOracleFetchTxid = await oracleContract.invoke(
    'grantModuleToMiniApp',
    [sc.ContractParam.string(appId), sc.ContractParam.string('oracle.fetch')],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, grantOracleFetchTxid), 'grantModuleToMiniApp');
  const setOracleTxid = await harnessContract.invoke(
    'setOracle',
    [sc.ContractParam.hash160(oracle.hash)],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, setOracleTxid), 'setOracle');
  const setAaCoreTxid = await harnessContract.invoke(
    'setAaCore',
    [sc.ContractParam.hash160(aaCore.hash)],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, setAaCoreTxid), 'setAaCore');

  const backupOwner = `0x${account.scriptHash}`;
  const accountA = {
    hookId: '0x0000000000000000000000000000000000000001',
  };
  const accountB = {
    hookId: '0x0000000000000000000000000000000000000002',
  };
  for (const accountConfig of [accountA, accountB]) {
    accountConfig.accountId = normalizeHash160(
      await invokeRead(rpcClient, aaCore.hash, 'computeRegistrationAccountId', [
        { type: 'Hash160', value: sessionVerifier.hash },
        { type: 'ByteArray', value: '' },
        { type: 'Hash160', value: accountConfig.hookId },
        { type: 'Hash160', value: backupOwner },
        { type: 'Integer', value: MIN_ESCAPE_TIMELOCK_SECONDS },
      ])
    );
    assertCondition(accountConfig.accountId, 'failed to compute registration account id');
    const txid = await coreContract.invoke(
      'registerAccount',
      [
        sc.ContractParam.hash160(accountConfig.accountId),
        sc.ContractParam.hash160(sessionVerifier.hash),
        byteArrayParam(''),
        sc.ContractParam.hash160(accountConfig.hookId),
        sc.ContractParam.hash160(backupOwner),
        sc.ContractParam.integer(MIN_ESCAPE_TIMELOCK_SECONDS),
      ],
      signers
    );
    assertHalt(
      await waitForApplicationLog(rpcClient, txid),
      `registerAccount:${accountConfig.accountId}`
    );
  }
  const accountIdA = accountA.accountId;
  const accountIdB = accountB.accountId;

  const feeStatus = await ensureRequestFeeCredit(
    account,
    rpcUrl,
    networkMagic,
    rpcClient,
    oracle.hash,
    2
  );

  const sourceReport = JSON.parse(await fs.readFile(SOURCE_CALLBACK_REPORT, 'utf8'));
  const sourceCase = sourceReport.cases?.find(
    (item) =>
      item.request_type === 'privacy_oracle' &&
      item.callback?.success === true &&
      item.callback?.result_json?.verification?.signature
  );
  assertCondition(sourceCase?.callback?.result_json, 'failed to load a source privacy_oracle callback result');
  const sourceResultText =
    sourceCase.callback.result_text || JSON.stringify(sourceCase.callback.result_json);
  const oldSignature = sourceCase.callback.result_json?.verification?.signature || '';
  assertCondition(trimString(oldSignature), 'source callback verification signature missing');

  const requestATxid = await harnessContract.invoke(
    'beginBoundRequest',
    [sc.ContractParam.hash160(accountIdA), sc.ContractParam.string('aa-bound-a')],
    signers
  );
  const requestAId = await waitForRequestId(rpcClient, requestATxid);
  const requestBTxid = await harnessContract.invoke(
    'beginBoundRequest',
    [sc.ContractParam.hash160(accountIdB), sc.ContractParam.string('aa-bound-b')],
    signers
  );
  const requestBId = await waitForRequestId(rpcClient, requestBTxid);

  const replayScript = sc.createScript({
    scriptHash: oracle.hash.replace(/^0x/i, ''),
    operation: 'fulfillRequest',
    args: [
      sc.ContractParam.integer(String(requestBId)),
      sc.ContractParam.boolean(true),
      byteArrayParam(Buffer.from(sourceResultText, 'utf8').toString('hex')),
      sc.ContractParam.string(''),
      byteArrayParam(oldSignature),
    ],
  });
  const replayAttempt = await sendInvocationTransaction({
    rpcClient,
    account,
    networkMagic,
    script: replayScript,
    signers: [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }],
  });
  const replayVmState = String(
    replayAttempt.execution.vmstate || replayAttempt.execution.state || ''
  );
  const replayException = String(replayAttempt.execution.exception || '');
  assertCondition(replayVmState.includes('FAULT'), 'AA-bound replay attempt should fault');
  assertCondition(
    /invalid verification signature/i.test(replayException),
    'AA-bound replay should fail with invalid verification signature'
  );

  const correctSignature = wallet.sign(
    buildFulfillmentDigestBytes(
      requestAId,
      'privacy_oracle',
      true,
      sourceResultText,
      '',
      '',
      {
        appId,
        moduleId: 'oracle.fetch',
        operation: 'privacy_oracle',
      }
    ).toString('hex'),
    account.privateKey
  );
  const fulfillAScript = sc.createScript({
    scriptHash: oracle.hash.replace(/^0x/i, ''),
    operation: 'fulfillRequest',
    args: [
      sc.ContractParam.integer(String(requestAId)),
      sc.ContractParam.boolean(true),
      byteArrayParam(Buffer.from(sourceResultText, 'utf8').toString('hex')),
      sc.ContractParam.string(''),
      byteArrayParam(correctSignature),
    ],
  });
  const fulfillA = await sendInvocationTransaction({
    rpcClient,
    account,
    networkMagic,
    script: fulfillAScript,
    signers: [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }],
  });
  const fulfillAVmState = String(fulfillA.execution.vmstate || fulfillA.execution.state || '');
  assertCondition(
    fulfillAVmState.includes('HALT'),
    `correct fulfill for account A should HALT, got ${fulfillAVmState} ${fulfillA.execution.exception || ''}`
  );

  const callbackA = await waitForCallback(rpcClient, harness.hash, requestAId, 180000);
  assertCondition(callbackA?.success === true, 'AA-bound request A should fulfill successfully');
  const unlockedA = Boolean(
    await invokeRead(rpcClient, harness.hash, 'isUnlocked', [
      { type: 'Hash160', value: accountIdA },
    ])
  );
  const unlockedB = Boolean(
    await invokeRead(rpcClient, harness.hash, 'isUnlocked', [
      { type: 'Hash160', value: accountIdB },
    ])
  );
  const pendingB = normalizeHash160(
    (await invokeRead(rpcClient, harness.hash, 'getPendingAccount', [
      { type: 'Integer', value: String(requestBId) },
    ])) || ''
  );
  assertCondition(unlockedA === true, 'account A should unlock after its valid callback');
  assertCondition(
    unlockedB === false,
    'account B must remain locked after replay attempt against its pending request'
  );
  assertCondition(
    pendingB === accountIdB,
    `account B pending request should remain bound, got ${pendingB}`
  );

  const generatedAt = new Date().toISOString();
  const jsonReport = {
    generated_at: generatedAt,
    network: 'testnet',
    rpc_url: rpcUrl,
    network_magic: networkMagic,
    oracle_hash: oracle.hash,
    aa_core_hash: aaCore.hash,
    session_verifier_hash: sessionVerifier.hash,
    callback_consumer_hash: harness.hash,
    request_fee_status: feeStatus,
    setup: {
      set_updater_txid: setUpdaterTxid,
      set_verifier_txid: setVerifierTxid,
      register_miniapp_txid: registerMiniAppTxid,
      grant_oracle_fetch_txid: grantOracleFetchTxid,
      set_oracle_txid: setOracleTxid,
      set_aa_core_txid: setAaCoreTxid,
    },
    accounts: {
      account_a: accountIdA,
      account_b: accountIdB,
    },
    requests: {
      request_a_txid: requestATxid,
      request_a_id: String(requestAId),
      request_b_txid: requestBTxid,
      request_b_id: String(requestBId),
    },
    replay_attempt: {
      txid: replayAttempt.txid,
      vmstate: replayVmState,
      exception: replayException,
    },
    fulfill_a: {
      txid: fulfillA.txid,
      vmstate: fulfillAVmState,
      callback: callbackA,
    },
    state_after_replay: {
      unlocked_a: unlockedA,
      unlocked_b: unlockedB,
      pending_b: pendingB,
    },
  };

  const markdownReport = [
    '# N3 AA-Bound Callback Replay Boundary Validation',
    '',
    `Date: ${generatedAt}`,
    '',
    '## Scope',
    '',
    'This probe deploys a temporary Oracle, a temporary AA core, and an AA-bound callback harness that records pending request -> accountId bindings. It then attempts to replay a valid Oracle-originated fulfillment signature into a different pending request bound to another AA account context.',
    '',
    '## Result',
    '',
    `- Temporary Oracle: \`${oracle.hash}\``,
    `- Temporary AA core: \`${aaCore.hash}\``,
    `- AA-bound harness: \`${harness.hash}\``,
    `- Request A id: \`${requestAId}\``,
    `- Request B id: \`${requestBId}\``,
    `- Replay tx: \`${replayAttempt.txid}\``,
    `- Replay exception: \`${replayException}\``,
    `- Fulfill A tx: \`${fulfillA.txid}\``,
    `- Account A unlocked: \`${unlockedA}\``,
    `- Account B unlocked: \`${unlockedB}\``,
    `- Account B pending binding: \`${pendingB}\``,
    '',
    '## Conclusion',
    '',
    'A valid fulfillment signature cannot be replayed into a different pending request even when both requests terminate at the same AA-bound consumer. The replay attempt faults at the Oracle verification layer, account A unlocks only through its own valid request, and account B remains locked and still bound to its pending request.',
    '',
  ].join('\n');

  const artifacts = await writeValidationArtifacts({
    baseName: 'n3-aa-callback-replay-boundary',
    network: 'testnet',
    generatedAt,
    jsonReport,
    markdownReport,
  });

  console.log(
    JSON.stringify(
      {
        ...artifacts,
        replay_txid: replayAttempt.txid,
        replay_exception: replayException,
        unlocked_a: unlockedA,
        unlocked_b: unlockedB,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  if (/method not found: addAllowedCallback|addAllowedCallback/i.test(message)) {
    writeSkippedValidationArtifacts({
      baseName: 'n3-aa-callback-replay-boundary',
      network: 'testnet',
      title: 'N3 AA-Bound Callback Replay Boundary Validation',
      reason: 'requires-deprecated-callback-allowlist-api',
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
  console.error(message);
  process.exit(1);
});
