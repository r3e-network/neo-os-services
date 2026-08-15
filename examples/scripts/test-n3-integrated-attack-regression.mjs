#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { experimental, rpc as neoRpc, sc, tx, wallet } from '@cityofzion/neon-js';
import {
  loadExampleEnv,
  normalizeHash160,
  readDeploymentRegistry,
  repoRelativePath,
  repoRoot,
  resolveNeoN3SignerWif,
  sleep,
  trimString,
  writeValidationArtifacts,
  withRetries,
} from './common.mjs';

const network = 'testnet';
const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const continueOnFailure =
  args.has('--continue-on-failure') || process.env.CONTINUE_ON_FAILURE === '1';
const runAaSuite = args.has('--run-aa') || process.env.RUN_AA_V3_SUITE === '1';
const skipAaSuite = args.has('--skip-aa');
const referenceHeavyStages =
  args.has('--reference-heavy-stages') ||
  process.env.ATTACK_REGRESSION_REFERENCE_HEAVY_STAGES === '1';
const referenceAllStages =
  args.has('--reference-all-stages') ||
  process.env.ATTACK_REGRESSION_REFERENCE_ALL_STAGES === '1';
const aaRepoRoot = path.resolve(repoRoot, '..', 'neo-abstract-account');
const aaSdkRoot = path.resolve(aaRepoRoot, 'sdk/js');
const aaSuiteLatestPath = path.resolve(
  aaRepoRoot,
  'sdk/docs/reports/v3-testnet-validation-suite.latest.json'
);
const overrideTestWif = trimString(process.env.TEST_WIF || '');
const testnetRpcUrl = trimString(
  process.env.TESTNET_RPC_URL ||
    process.env.NEO_TESTNET_RPC_URL ||
    'https://testnet1.neo.coz.io:443'
);
const sharedTestnetEnv = {
  MORPHEUS_NETWORK: network,
  NEXT_PUBLIC_MORPHEUS_NETWORK: network,
  TESTNET_RPC_URL: testnetRpcUrl,
  NEO_RPC_URL: testnetRpcUrl,
  ...(trimString(process.env.PAYMASTER_ACCOUNT_ID || '')
    ? { PAYMASTER_ACCOUNT_ID: trimString(process.env.PAYMASTER_ACCOUNT_ID || '') }
    : {}),
  ...(overrideTestWif
    ? {
        NEO_TESTNET_WIF: overrideTestWif,
        MORPHEUS_RELAYER_NEO_N3_WIF: overrideTestWif,
      }
    : {}),
};

function stageReportPath(relativePath) {
  return path.resolve(repoRoot, relativePath);
}

function summarizeAaSuite(report) {
  const stageSummaries = Array.isArray(report?.stages) ? report.stages : [];
  const paymasterPolicy =
    stageSummaries.find((stage) => stage?.id === 'paymaster_policy')?.summary || {};
  const paymaster = stageSummaries.find((stage) => stage?.id === 'paymaster')?.summary || {};
  return {
    stage_ids: stageSummaries.map((stage) => stage.id),
    paymaster_policy_denied_cases: paymasterPolicy.deniedCases || [],
    paymaster_txid: paymaster.txid || null,
    paymaster_approval_digest: paymaster.approvalDigest || null,
  };
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function parseStackItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = trimString(item.type).toLowerCase();
  if (type === 'integer' || type === 'string' || type === 'hash160')
    return String(item.value ?? '');
  if (type === 'boolean') return Boolean(item.value);
  return item.value ?? null;
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

async function waitForCredit(
  rpcClient,
  oracleHash,
  beneficiary,
  requiredCredit,
  timeoutMs = 60000
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const updatedCredit = BigInt(
      (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
        { type: 'Hash160', value: beneficiary },
      ])) || '0'
    );
    if (updatedCredit >= requiredCredit) return updatedCredit;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for Oracle fee credit for ${beneficiary}`);
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

async function ensureRequesterCredit({
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  requiredRequests,
}) {
  const requesterHash = `0x${account.scriptHash}`;
  const currentCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: requesterHash },
    ])) || '0'
  );
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  const requiredCredit = requestFee * BigInt(requiredRequests);
  if (requestFee <= 0n || currentCredit >= requiredCredit) {
    return {
      request_fee: requestFee.toString(),
      requester_credit: currentCredit.toString(),
      deposit_amount: '0',
      txid: null,
    };
  }

  const deficit = requiredCredit - currentCredit;
  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const txid = await gas.invoke('transfer', [
    sc.ContractParam.hash160(requesterHash),
    sc.ContractParam.hash160(oracleHash),
    sc.ContractParam.integer(deficit.toString()),
    sc.ContractParam.any(null),
  ]);
  await waitForApplicationLog(rpcClient, txid);
  const updatedCredit = await waitForCredit(rpcClient, oracleHash, requesterHash, requiredCredit);
  return {
    request_fee: requestFee.toString(),
    requester_credit: updatedCredit.toString(),
    deposit_amount: deficit.toString(),
    txid,
  };
}

async function ensureExampleConsumerCredit({
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  consumerHash,
  requiredRequests,
}) {
  if (!consumerHash) {
    return {
      request_fee: '0',
      callback_credit: '0',
      deposit_amount: '0',
      funding_txid: null,
      deposit_txid: null,
    };
  }
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  let callbackCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: consumerHash },
    ])) || '0'
  );
  const requiredCredit = requestFee * BigInt(requiredRequests);
  if (requestFee <= 0n || callbackCredit >= requiredCredit) {
    return {
      request_fee: requestFee.toString(),
      callback_credit: callbackCredit.toString(),
      deposit_amount: '0',
      funding_txid: null,
      deposit_txid: null,
    };
  }

  const deficit = requiredCredit - callbackCredit;
  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const fundingSigners = [
    new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }),
  ];
  const fundingTxid = await gas.invoke(
    'transfer',
    [
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.hash160(consumerHash),
      sc.ContractParam.integer(deficit.toString()),
      sc.ContractParam.any(null),
    ],
    fundingSigners
  );
  await waitForApplicationLog(rpcClient, fundingTxid);

  let contractGasBalance = 0n;
  const balanceDeadline = Date.now() + 60000;
  while (Date.now() < balanceDeadline) {
    contractGasBalance = BigInt(
      (await invokeRead(rpcClient, consumerHash, 'contractGasBalance', []).catch(() => '0')) || '0'
    );
    if (contractGasBalance >= deficit) break;
    await sleep(2000);
  }
  assertCondition(
    contractGasBalance >= deficit,
    'example callback consumer lacks enough GAS to top up Oracle credit'
  );

  const consumer = new experimental.SmartContract(consumerHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];
  const depositTxid = await consumer.invoke(
    'depositOracleCredits',
    [sc.ContractParam.integer(deficit.toString())],
    signers
  );
  await waitForApplicationLog(rpcClient, depositTxid);
  callbackCredit = await waitForCredit(rpcClient, oracleHash, consumerHash, requiredCredit);
  return {
    request_fee: requestFee.toString(),
    callback_credit: callbackCredit.toString(),
    deposit_amount: deficit.toString(),
    funding_txid: fundingTxid,
    deposit_txid: depositTxid,
  };
}

async function ensureIntegratedPreflight({ requesterRequests = 0, consumerRequests = 0 } = {}) {
  const deployment = (await readDeploymentRegistry(network)).neo_n3 || {};
  const rpcUrl = trimString(deployment.rpc_url || 'https://testnet1.neo.coz.io:443');
  const networkMagic = Number(deployment.network_magic || 894710606);
  const oracleHash = normalizeHash160(deployment.oracle_hash || '');
  const consumerHash = normalizeHash160(deployment.example_consumer_hash || '');
  const signerWif = overrideTestWif || resolveNeoN3SignerWif(network);
  assertCondition(signerWif, 'testnet signer WIF is required for integrated preflight');
  assertCondition(oracleHash, 'testnet oracle hash is required for integrated preflight');
  const account = new wallet.Account(signerWif);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);

  const requester =
    requesterRequests > 0
      ? await ensureRequesterCredit({
          account,
          rpcUrl,
          networkMagic,
          rpcClient,
          oracleHash,
          requiredRequests: requesterRequests,
        })
      : null;

  const consumer =
    consumerRequests > 0
      ? await ensureExampleConsumerCredit({
          account,
          rpcUrl,
          networkMagic,
          rpcClient,
          oracleHash,
          consumerHash,
          requiredRequests: consumerRequests,
        })
      : null;

  return {
    rpc_url: rpcUrl,
    network_magic: networkMagic,
    oracle_hash: oracleHash,
    consumer_hash: consumerHash,
    requester,
    consumer,
  };
}

function summarizeCallbackBoundary(report) {
  return {
    txid: report?.probe?.txid || null,
    vmstate: report?.probe?.vmstate || null,
    exception: report?.probe?.exception || null,
  };
}

function summarizeNeoDidRegistryBoundary(report) {
  return {
    registry_hash: report?.registry_hash || null,
    wrong_witness_exception: report?.wrong_witness_preview?.exception || null,
    mismatch_exception: report?.registry_probe?.exception || null,
  };
}

function summarizeNeoDidRegistryV1(report) {
  return {
    registry_hash: report?.registry_hash || null,
    consume_txid: report?.consume_probe?.txid || null,
    replay_exception: report?.replay_probe?.exception || null,
  };
}

function summarizeEncryptedRefBoundary(report) {
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  return {
    matching_success: cases[0]?.callback?.success ?? null,
    wrong_requester_error: cases[1]?.callback?.error_text || null,
    wrong_callback_error: cases[2]?.callback?.error_text || null,
    replay_error: cases[4]?.callback?.error_text || null,
  };
}

function summarizeFulfillmentReplay(report) {
  return {
    replay_exception: report?.replay_target?.replay_exception || null,
    fulfill_vmstate: report?.replay_target?.fulfill_vmstate || null,
    fulfill_txid: report?.replay_target?.fulfill_txid || null,
  };
}

function summarizeAaSessionOracleBoundary(report) {
  return {
    execute_txid: report?.success_path?.execute_txid || null,
    request_id: report?.success_path?.request_id || null,
    wrong_target_exception: report?.wrong_target?.exception || null,
    wrong_method_exception: report?.wrong_method?.exception || null,
  };
}

function summarizeAaCallbackReplayBoundary(report) {
  return {
    replay_txid: report?.replay_attempt?.txid || report?.replay_txid || null,
    replay_exception: report?.replay_attempt?.exception || report?.replay_exception || null,
    unlocked_a: report?.state_after_replay?.unlocked_a ?? report?.unlocked_a ?? null,
    unlocked_b: report?.state_after_replay?.unlocked_b ?? report?.unlocked_b ?? null,
  };
}

function summarizeAaRecoveryCrossAccountBoundary(report) {
  return {
    recovery_verifier_hash: report?.recovery_verifier_hash || null,
    recovery_request_id: report?.recovery_request_id || null,
    wrong_account_state: report?.wrong_account_state || null,
    wrong_account_exception: report?.wrong_account_exception || null,
  };
}

function summarizeAaPaymasterAutomationOracle(report) {
  return {
    paymaster_policy_id: report?.paymaster?.policy_id || null,
    paymaster_approved: report?.paymaster?.approved ?? null,
    relay_txid: report?.relay?.txid || null,
    automation_id: report?.automation_register?.automation_id || null,
    queued_mode: report?.queued_execution?.mode || 'scheduler',
    queued_chain_request_id: report?.queued_execution?.request_id || null,
    queued_callback_success: report?.queued_execution?.callback?.success ?? null,
  };
}

function summarizeAutomationIdempotency(report) {
  const runs = Array.isArray(report?.supabase?.runs) ? report.supabase.runs : [];
  return {
    automation_id: report?.registration?.automation_id || null,
    queued_request_key: report?.queued_request_key || null,
    queued_chain_request_id: report?.queued_chain_request_id || null,
    queued_callback_success: report?.queued_callback?.success ?? null,
    execution_count: report?.supabase?.job?.execution_count ?? null,
    queued_runs: runs.filter((row) => row?.status === 'queued').length,
    failed_runs: runs.filter((row) => row?.status === 'failed').length,
  };
}

function summarizeAutomationCancelRace(report) {
  return {
    automation_id: report?.automation_id || null,
    queued_chain_request_id: report?.queued_chain_request_id || null,
    executed_after_cancel: report?.executed_after_cancel ?? null,
  };
}

function summarizeAutomationDepositExhaustion(report) {
  return {
    shared_requester_hash: report?.shared_requester_hash || null,
    queued_runs: Array.isArray(report?.queued_runs)
      ? report.queued_runs.length
      : (report?.queued_runs ?? null),
    failed_runs: Array.isArray(report?.failed_runs)
      ? report.failed_runs.length
      : (report?.failed_runs ?? null),
    queued_chain_request_id: report?.queued_chain_request_id || null,
    failed_error: report?.failed_runs?.[0]?.error || report?.failed_error || null,
  };
}

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function summarizeStage(stage, report) {
  if (!report || typeof stage.summarize !== 'function') return null;
  return stage.summarize(report);
}

function normalizeSignal(signal) {
  return signal ? String(signal) : null;
}

function isTransientStageFailure(output = '') {
  const text = String(output || '');
  return /EADDRNOTAVAIL|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|network error|EAI_AGAIN|ECONNREFUSED|temporarily unavailable/i.test(
    text
  );
}

function makeStage(
  id,
  title,
  command,
  argsList,
  cwd,
  reportRelativePath,
  summarize,
  env = undefined,
  preflight = null,
  retries = 0
) {
  return {
    id,
    title,
    kind: 'command',
    command,
    args: argsList,
    cwd,
    env,
    preflight,
    retries,
    reportPath: reportRelativePath ? stageReportPath(reportRelativePath) : null,
    summarize,
  };
}

const stages = [];

if (!skipAaSuite) {
  if (runAaSuite) {
    stages.push({
      id: 'aa_v3_suite',
      title: 'AA V3 testnet validation suite',
      kind: 'command',
      command: 'npm',
      args: ['run', 'testnet:validate'],
      cwd: aaSdkRoot,
      reportPath: aaSuiteLatestPath,
      summarize: summarizeAaSuite,
    });
  } else {
    stages.push({
      id: 'aa_v3_suite',
      title: 'AA V3 testnet validation suite',
      kind: 'reference',
      cwd: aaSdkRoot,
      reportPath: aaSuiteLatestPath,
      summarize: summarizeAaSuite,
    });
  }
}

stages.push(
  ...(referenceAllStages
    ? [
        {
          id: 'callback_boundary',
          title: 'Oracle callback injection boundary',
          kind: 'reference',
          cwd: repoRoot,
          reportPath: stageReportPath('examples/deployments/n3-callback-boundary.testnet.latest.json'),
          summarize: summarizeCallbackBoundary,
        },
      ]
    : [
        makeStage(
          'callback_boundary',
          'Oracle callback injection boundary',
          'node',
          [path.resolve(repoRoot, 'examples/scripts/test-n3-callback-boundary.mjs')],
          repoRoot,
          'examples/deployments/n3-callback-boundary.testnet.latest.json',
          summarizeCallbackBoundary,
          sharedTestnetEnv,
          null
        ),
      ]),
  {
    id: 'neodid_registry_boundary',
    title: 'NeoDID registry JSON ticket boundary',
    kind: 'reference',
    cwd: repoRoot,
    reportPath: stageReportPath(
      'examples/deployments/n3-neodid-registry-boundary.testnet.latest.json'
    ),
    summarize: summarizeNeoDidRegistryBoundary,
  },
  {
    id: 'neodid_registry_v1',
    title: 'NeoDID registry compact ticket replay boundary',
    kind: 'reference',
    cwd: repoRoot,
    reportPath: stageReportPath('examples/deployments/n3-neodid-registry-v1.testnet.latest.json'),
    summarize: summarizeNeoDidRegistryV1,
  },
  ...(referenceAllStages
    ? [
        {
          id: 'encrypted_ref_boundary',
          title: 'Encrypted ref requester/callback binding boundary',
          kind: 'reference',
          cwd: repoRoot,
          reportPath: stageReportPath(
            'examples/deployments/n3-encrypted-ref-boundary.testnet.latest.json'
          ),
          summarize: summarizeEncryptedRefBoundary,
        },
        {
          id: 'fulfillment_replay',
          title: 'Fulfillment replay boundary',
          kind: 'reference',
          cwd: repoRoot,
          reportPath: stageReportPath(
            'examples/deployments/n3-fulfillment-replay.testnet.latest.json'
          ),
          summarize: summarizeFulfillmentReplay,
        },
      ]
    : [
        makeStage(
          'encrypted_ref_boundary',
          'Encrypted ref requester/callback binding boundary',
          'node',
          [path.resolve(repoRoot, 'examples/scripts/test-n3-encrypted-ref-boundary.mjs')],
          repoRoot,
          'examples/deployments/n3-encrypted-ref-boundary.testnet.latest.json',
          summarizeEncryptedRefBoundary,
          sharedTestnetEnv,
          null
        ),
        makeStage(
          'fulfillment_replay',
          'Fulfillment replay boundary',
          'node',
          [path.resolve(repoRoot, 'examples/scripts/test-n3-fulfillment-replay-isolated.mjs')],
          repoRoot,
          'examples/deployments/n3-fulfillment-replay.testnet.latest.json',
          summarizeFulfillmentReplay,
          sharedTestnetEnv,
          null
        ),
      ]),
  ...(referenceHeavyStages
    ? [
        {
          id: 'aa_session_oracle_boundary',
          title: 'AA session-key downstream Oracle boundary',
          kind: 'reference',
          cwd: repoRoot,
          reportPath: stageReportPath(
            'examples/deployments/n3-aa-session-oracle-boundary.testnet.latest.json'
          ),
          summarize: summarizeAaSessionOracleBoundary,
        },
      ]
    : [
        makeStage(
          'aa_session_oracle_boundary',
          'AA session-key downstream Oracle boundary',
          'node',
          [path.resolve(repoRoot, 'examples/scripts/test-n3-aa-session-oracle-boundary.mjs')],
          repoRoot,
          'examples/deployments/n3-aa-session-oracle-boundary.testnet.latest.json',
          summarizeAaSessionOracleBoundary,
          sharedTestnetEnv,
          null
        ),
      ]),
  {
    id: 'aa_callback_replay_boundary',
    title: 'AA-bound callback replay boundary',
    kind: 'reference',
    cwd: repoRoot,
    reportPath: stageReportPath(
      'examples/deployments/n3-aa-callback-replay-boundary.testnet.latest.json'
    ),
    summarize: summarizeAaCallbackReplayBoundary,
  },
  {
    id: 'aa_recovery_cross_account_boundary',
    title: 'AA recovery cross-account boundary',
    kind: 'reference',
    cwd: repoRoot,
    reportPath: stageReportPath(
      'examples/deployments/n3-aa-recovery-cross-account-boundary.testnet.latest.json'
    ),
    summarize: summarizeAaRecoveryCrossAccountBoundary,
  },
  ...(referenceHeavyStages
    ? [
        {
          id: 'aa_paymaster_automation_oracle',
          title: 'AA paymaster automation Oracle proof',
          kind: 'reference',
          cwd: repoRoot,
          reportPath: stageReportPath(
            'examples/deployments/n3-aa-paymaster-automation-oracle.testnet.latest.json'
          ),
          summarize: summarizeAaPaymasterAutomationOracle,
        },
      ]
    : [
        makeStage(
          'aa_paymaster_automation_oracle',
          'AA paymaster automation Oracle proof',
          'node',
          [path.resolve(repoRoot, 'examples/scripts/test-n3-aa-paymaster-automation-oracle.mjs')],
          repoRoot,
          'examples/deployments/n3-aa-paymaster-automation-oracle.testnet.latest.json',
          summarizeAaPaymasterAutomationOracle,
          sharedTestnetEnv,
          null
        ),
      ]),
  {
    id: 'automation_cancel_race',
    title: 'Automation cancellation race',
    kind: 'reference',
    cwd: repoRoot,
    reportPath: stageReportPath(
      'examples/deployments/n3-automation-cancel-race.testnet.latest.json'
    ),
    summarize: summarizeAutomationCancelRace,
  },
  {
    id: 'automation_deposit_exhaustion',
    title: 'Automation shared-credit deposit exhaustion',
    kind: 'reference',
    cwd: repoRoot,
    reportPath: stageReportPath(
      'examples/deployments/n3-automation-deposit-exhaustion.testnet.latest.json'
    ),
    summarize: summarizeAutomationDepositExhaustion,
  },
  {
    id: 'automation_idempotency',
    title: 'Automation duplicate-queue suppression',
    kind: 'reference',
    cwd: repoRoot,
    reportPath: stageReportPath(
      'examples/deployments/n3-automation-idempotency.testnet.latest.json'
    ),
    summarize: summarizeAutomationIdempotency,
  }
);

function printStagePlan(stage) {
  if (stage.kind === 'reference') {
    console.log(`- ${stage.id}: reference latest artifact ${repoRelativePath(stage.reportPath)}`);
    return;
  }
  const relArgs = stage.args.map((value) =>
    value.startsWith(repoRoot) ? repoRelativePath(value) : value
  );
  console.log(
    `- ${stage.id}: ${[stage.command, ...relArgs].join(' ')} (${repoRelativePath(stage.cwd) || '.'})`
  );
}

async function runCommandStage(stage) {
  let lastResult = null;
  const attempts = Math.max(Number(stage.retries ?? 1), 0) + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    console.log(`\n==> ${stage.id}: ${stage.title}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);
    let preflight = null;
    try {
      preflight = stage.preflight ? await ensureIntegratedPreflight(stage.preflight) : null;
    } catch (error) {
      lastResult = {
        id: stage.id,
        title: stage.title,
        mode: 'executed',
        status: 'failed',
        exit_code: null,
        signal: null,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs,
        preflight,
        report_path: null,
        summary: null,
        failure_phase: 'preflight',
        error: error instanceof Error ? error.message : String(error),
        attempt,
      };
      if (attempt < attempts) continue;
      return lastResult;
    }

    const result = spawnSync(stage.command, stage.args, {
      cwd: stage.cwd,
      env: { ...process.env, ...(stage.env || {}) },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
    const transientFailure =
      result.status !== 0 &&
      attempt < attempts &&
      isTransientStageFailure(combinedOutput);
    if (transientFailure) {
      console.warn(
        `[retry] ${stage.id} transient failure on attempt ${attempt}/${attempts}: retrying`
      );
      await sleep(2000 * attempt);
      continue;
    }
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;
    const report = result.status === 0 ? readJsonIfPresent(stage.reportPath) : null;
    lastResult = {
      id: stage.id,
      title: stage.title,
      mode: 'executed',
      status: result.status === 0 ? 'passed' : 'failed',
      exit_code: result.status ?? null,
      signal: normalizeSignal(result.signal),
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      preflight,
      report_path:
        result.status === 0 && stage.reportPath && fs.existsSync(stage.reportPath)
          ? repoRelativePath(stage.reportPath)
          : null,
      summary: summarizeStage(stage, report),
      error: result.status === 0 ? null : `stage exited with code ${result.status ?? 'unknown'}`,
      attempt,
    };
    if (result.status === 0 || attempt >= attempts) {
      return lastResult;
    }
  }
  return lastResult;
}

function referenceStage(stage) {
  const report = readJsonIfPresent(stage.reportPath);
  return {
    id: stage.id,
    title: stage.title,
    mode: 'reference_latest',
    status: report ? 'referenced_latest' : 'missing_latest',
    exit_code: null,
    signal: null,
    started_at: null,
    completed_at: null,
    duration_ms: 0,
    report_path: report ? repoRelativePath(stage.reportPath) : null,
    summary: summarizeStage(stage, report),
  };
}

function buildMarkdownReport(report) {
  const lines = [
    '# N3 Integrated Attack Regression',
    '',
    `Date: ${report.generated_at}`,
    '',
    '## Scope',
    '',
    'This runner tracks the currently executable Neo N3 integrated attack regression set across Morpheus Oracle, NeoDID, and the AA verifier baseline.',
    '',
    '## Configuration',
    '',
    `- network: \`${report.network}\``,
    `- dry_run: \`${report.dry_run}\``,
    `- continue_on_failure: \`${report.continue_on_failure}\``,
    `- AA suite mode: \`${report.aa_suite_mode}\``,
    '',
    '## Stage Results',
    '',
  ];

  for (const stage of report.stages) {
    lines.push(`- ${stage.id}: \`${stage.status}\``);
    if (stage.report_path) lines.push(`  report: \`${stage.report_path}\``);
    if (stage.summary) lines.push(`  summary: \`${JSON.stringify(stage.summary)}\``);
    if (stage.error) lines.push(`  error: \`${stage.error}\``);
  }

  lines.push(
    '',
    '## Remaining Integrated Gaps',
    '',
    ...(report.remaining_gaps.length > 0
      ? report.remaining_gaps.map((item) => `- ${item}`)
      : ['- none']),
    ''
  );

  return `${lines.join('\n')}\n`;
}

async function main() {
  await loadExampleEnv();

  const aaSuiteMode = skipAaSuite ? 'skipped' : runAaSuite ? 'executed' : 'referenced_latest';

  console.log('==> integrated attack regression plan');
  for (const stage of stages) printStagePlan(stage);

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          network,
          dry_run: true,
          continue_on_failure: continueOnFailure,
          aa_suite_mode: aaSuiteMode,
          preflight: null,
          stages: stages.map((stage) => ({
            id: stage.id,
            title: stage.title,
            kind: stage.kind,
            cwd: stage.cwd.startsWith(repoRoot) ? repoRelativePath(stage.cwd) : stage.cwd,
            report_path:
              stage.reportPath && fs.existsSync(stage.reportPath)
                ? repoRelativePath(stage.reportPath)
                : stage.reportPath
                  ? repoRelativePath(stage.reportPath)
                  : null,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  const stageResults = [];
  for (const stage of stages) {
    const result =
      stage.kind === 'reference' ? referenceStage(stage) : await runCommandStage(stage);
    stageResults.push(result);
    if (result.status === 'failed' && !continueOnFailure) {
      break;
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    network,
    dry_run: false,
    continue_on_failure: continueOnFailure,
    aa_suite_mode: aaSuiteMode,
    preflight: null,
    stages: stageResults,
    remaining_gaps: [],
  };

  const paymasterAutomationStage = stageResults.find(
    (stage) => stage.id === 'aa_paymaster_automation_oracle'
  );
  const paymasterAutomationPassed = Boolean(
    paymasterAutomationStage &&
    !['failed', 'missing_latest'].includes(paymasterAutomationStage.status) &&
    paymasterAutomationStage.summary?.queued_callback_success === true
  );
  if (!paymasterAutomationPassed) {
    report.remaining_gaps.push(
      'AA-sponsored automation execution where paymaster policy also constrains the downstream Oracle path'
    );
  }

  const markdownReport = buildMarkdownReport(report);
  const artifacts = await writeValidationArtifacts({
    baseName: 'n3-integrated-attack-regression',
    network,
    jsonReport: report,
    markdownReport,
  });

  console.log(
    JSON.stringify(
      {
        ...artifacts,
        failed_stages: stageResults
          .filter((stage) => stage.status === 'failed')
          .map((stage) => stage.id),
        referenced_stages: stageResults
          .filter((stage) => stage.status === 'referenced_latest')
          .map((stage) => stage.id),
      },
      null,
      2
    )
  );

  const hasFailure = stageResults.some(
    (stage) => stage.status === 'failed' || stage.status === 'missing_latest'
  );
  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
