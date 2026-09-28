#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { experimental, rpc as neoRpc, sc, tx, u, wallet } from '@cityofzion/neon-js';
import { loadDotEnv } from '../lib-env.mjs';
import {
  normalizeHash160,
  normalizeMorpheusNetwork,
  resolvePinnedNeoN3Role,
} from '../lib-neo-signers.mjs';
import { parseGasToRaw } from '../lib-gas-units.mjs';
import { trimString } from '../lib-strings.mjs';
import { withRetries } from '../lib-verify-morpheus-n3.mjs';
import {
  readReviewedNetworkRegistrySync,
  resolveReviewedNeoN3Magic,
} from '../lib-network-registry.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const ADMIN_ADDRESS = 'NUVmRwZDoSZMKcPj9UCQLHkpno2TPqYVxC';
const ADMIN_HASH = `0x${wallet.getScriptHashFromAddress(ADMIN_ADDRESS).toLowerCase()}`;
const ADMIN_DSTACK_KEY_ROLE = trimString(process.env.MORPHEUS_ADMIN_DSTACK_KEY_ROLE) || 'neodid';
const DEFAULT_METADATA_URI = 'https://oracle.meshmini.app/mainnet/runtime/catalog';
const DEFAULT_CREDIT_REQUESTS = 20n;
const PLATFORM_GAME_APP_ID = 'morpheus.platform.game';
const PLATFORM_GAME_MODULE = {
  moduleId: 'vrf_random',
  endpoint: '/vrf/random',
  schemaHash: 'morpheus.module.vrf_random.v1',
};

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has('--execute');
const SKIP_CREDIT = args.has('--skip-credit');
const UPDATE_CONTRACT = args.has('--update-contract');
const explicitContractEnv = {
  CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET: trimString(
    process.env.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET
  ),
  CONTRACT_MORPHEUS_ORACLE_HASH: trimString(process.env.CONTRACT_MORPHEUS_ORACLE_HASH),
  CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH_MAINNET: trimString(
    process.env.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH_MAINNET
  ),
  CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH: trimString(
    process.env.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH
  ),
};

function strip0x(value) {
  return trimString(value).replace(/^0x/i, '').toLowerCase();
}

// normalizeHash160 is imported from ./lib-neo-signers.mjs (single source of truth
// for contract/address hash normalization across the mainnet maintenance scripts).
// strip0x stays — it has ~8 other call sites on the witness/signer path here.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawGasToDecimal(raw) {
  const value = BigInt(raw || 0);
  const whole = value / 100000000n;
  const fraction = String(value % 100000000n)
    .padStart(8, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

// parseGasToRaw is imported from ./lib-gas-units.mjs — the tested, exact-BigInt
// implementation shared with the rest of the gas-budget tooling. (The previous
// local copy diverged: it rejected a leading '+' and >8-decimal input by falling
// back, where the canonical version accepts '+' and rounds >8-decimal input up by
// one base unit. The canonical exact-BigInt semantics are the intended behavior.)

function parseStackBytes(value) {
  const raw = trimString(value);
  if (!raw) return Buffer.alloc(0);
  try {
    return Buffer.from(raw, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

function parseStackItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = trimString(item.type).toLowerCase();
  switch (type) {
    case 'integer':
      return String(item.value ?? '0');
    case 'boolean':
      return Boolean(item.value);
    case 'hash160':
    case 'hash256':
      return String(item.value ?? '');
    case 'string':
      return String(item.value ?? '');
    case 'bytestring':
    case 'bytearray': {
      const bytes = parseStackBytes(item.value);
      if (bytes.length === 20) return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
      const text = bytes.toString('utf8');
      return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? text : bytes.toString('hex');
    }
    case 'array':
    case 'struct':
      return Array.isArray(item.value) ? item.value.map(parseStackItem) : [];
    default:
      return item.value ?? null;
  }
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function loadJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
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

async function getGasBalanceRaw(rpcClient, scriptHash) {
  return BigInt(
    (await invokeRead(rpcClient, GAS_HASH, 'balanceOf', [
      { type: 'Hash160', value: normalizeHash160(scriptHash) },
    ])) || '0'
  );
}

async function waitForTransactionExecution(rpcClient, txid, timeoutMs = 180000) {
  const normalized = txid.startsWith('0x') ? txid : `0x${txid}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const appLog = await rpcClient.getApplicationLog(normalized);
      const execution = appLog?.executions?.[0];
      if (execution) {
        const vmstate = String(execution.vmstate || execution.state || '');
        return {
          txid: normalized,
          vmstate,
          exception: execution.exception || null,
        };
      }
    } catch {}
    await sleep(2500);
  }
  throw new Error(`timed out waiting for ${normalized}`);
}

async function assertHalt(rpcClient, txid, label) {
  const execution = await waitForTransactionExecution(rpcClient, txid);
  if (!execution.vmstate.includes('HALT')) {
    throw new Error(
      `${label} faulted for ${execution.txid}: ${execution.exception || execution.vmstate}`
    );
  }
  return execution;
}

function buildSignatureWitness(signature, publicKey) {
  return tx.Witness.fromSignature(strip0x(signature), strip0x(publicKey));
}

function normalizePublicKey(value) {
  const publicKey = strip0x(value);
  if (!/^[0-9a-f]{66}$/.test(publicKey) && !/^[0-9a-f]{130}$/.test(publicKey)) {
    throw new Error('derived signer returned an invalid public key');
  }
  return publicKey;
}

function normalizePublicKeyOrEmpty(value) {
  const publicKey = strip0x(value);
  return /^[0-9a-f]{66}$/.test(publicKey) || /^[0-9a-f]{130}$/.test(publicKey) ? publicKey : '';
}

function normalizeSignature(value) {
  const signature = strip0x(value);
  if (!/^[0-9a-f]{128}$/.test(signature)) {
    throw new Error('derived signer returned an invalid signature');
  }
  return signature;
}

async function rpcPost(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (!response.ok) {
    throw new Error(`${method} HTTP ${response.status}: ${await response.text()}`);
  }
  const json = await response.json();
  if (json.error) throw new Error(`${method} RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

function buildHeaders(token) {
  const headers = { 'content-type': 'application/json', 'x-morpheus-network': 'mainnet' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function signWithDerivedAdmin(runtimeUrls, token, messageHex) {
  const failures = [];
  for (const runtimeUrl of runtimeUrls) {
    if (!runtimeUrl) continue;
    try {
      return await withRetries(`signWithDerivedAdmin:${runtimeUrl}`, async () => {
        const response = await fetch(`${runtimeUrl.replace(/\/$/, '')}/sign/payload`, {
          method: 'POST',
          headers: buildHeaders(token),
          body: JSON.stringify({
            target_chain: 'neo_n3',
            data_hex: messageHex,
            use_derived_keys: true,
            dstack_key_role: ADMIN_DSTACK_KEY_ROLE,
          }),
        });
        if (!response.ok) {
          throw new Error(`sign/payload failed: ${response.status} ${await response.text()}`);
        }

        const signed = await response.json();
        const signature = normalizeSignature(signed.signature || signed.signature_hex || '');
        const publicKey = normalizePublicKey(signed.public_key || signed.publicKey || '');
        const signerHash = normalizeHash160(
          signed.script_hash ||
            signed.address ||
            `0x${wallet.getScriptHashFromPublicKey(publicKey)}`
        );
        if (signerHash !== ADMIN_HASH) {
          throw new Error(
            `derived signer hash mismatch: expected ${ADMIN_HASH}, got ${signerHash || 'unknown'}`
          );
        }
        return { signature, publicKey };
      });
    } catch (error) {
      failures.push(`${runtimeUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`failed to sign with derived admin: ${failures.join('; ')}`);
}

async function fetchRuntimePublicKey(runtimeUrls, token) {
  const failures = [];
  for (const runtimeUrl of runtimeUrls) {
    if (!runtimeUrl) continue;
    try {
      const response = await fetch(`${runtimeUrl.replace(/\/$/, '')}/oracle/public-key`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        failures.push(`${runtimeUrl}: HTTP ${response.status}`);
        continue;
      }
      const key = await response.json();
      const algorithm = trimString(key.algorithm);
      const publicKey = trimString(key.public_key || key.publicKey);
      if (!algorithm || !publicKey) {
        failures.push(`${runtimeUrl}: empty key payload`);
        continue;
      }
      return { algorithm, publicKey, source: runtimeUrl };
    } catch (error) {
      failures.push(`${runtimeUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`failed to fetch runtime public key: ${failures.join('; ')}`);
}

async function fetchRuntimeDerivedNeoN3Key(runtimeUrls, token, role) {
  const failures = [];
  for (const runtimeUrl of runtimeUrls) {
    if (!runtimeUrl) continue;
    try {
      const response = await fetch(`${runtimeUrl.replace(/\/$/, '')}/keys/derived`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify({ role, network: 'mainnet' }),
      });
      if (!response.ok) {
        failures.push(`${runtimeUrl}: HTTP ${response.status}`);
        continue;
      }
      const body = await response.json();
      const neo = body?.derived?.neo_n3 || body?.neo_n3 || {};
      const scriptHash = normalizeHash160(neo.script_hash || neo.address);
      const publicKey = normalizePublicKey(neo.public_key || '');
      if (!scriptHash || !publicKey) {
        failures.push(`${runtimeUrl}: empty derived ${role} Neo N3 payload`);
        continue;
      }
      return {
        role,
        source: runtimeUrl,
        address: trimString(neo.address),
        script_hash: scriptHash,
        public_key: publicKey,
        key_path: trimString(neo.key_path),
      };
    } catch (error) {
      failures.push(`${runtimeUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`failed to fetch runtime derived ${role} key: ${failures.join('; ')}`);
}

async function buildDerivedAdminTx({
  rpcClient,
  rpcUrl,
  networkMagic,
  runtimeSignUrls,
  token,
  contractHash,
  operation,
  params,
}) {
  const script = sc.createScript({
    scriptHash: strip0x(contractHash),
    operation,
    args: params,
  });
  const blockCount = await rpcClient.getBlockCount();
  const transaction = new tx.Transaction({
    script: u.HexString.fromHex(script),
    validUntilBlock: blockCount + 120,
    signers: [{ account: strip0x(ADMIN_HASH), scopes: tx.WitnessScope.CalledByEntry }],
    attributes: [],
    witnesses: [],
  });

  const testInvoke = await rpcClient.invokeScript(transaction.script, [
    { account: strip0x(ADMIN_HASH), scopes: 'CalledByEntry' },
  ]);
  if (String(testInvoke.state || '').toUpperCase() === 'FAULT') {
    throw new Error(`${operation} test invoke faulted: ${testInvoke.exception || 'unknown error'}`);
  }
  const gasConsumed = BigInt(testInvoke.gasconsumed || testInvoke.gas_consumed || '0');
  transaction.systemFee = u.BigInteger.fromDecimal(
    String(gasConsumed + gasConsumed / 5n + 100000n),
    0
  );

  const publicKeyProbe = await signWithDerivedAdmin(
    runtimeSignUrls,
    token,
    transaction.getMessageForSigning(networkMagic)
  );
  transaction.witnesses = [
    buildSignatureWitness(publicKeyProbe.signature, publicKeyProbe.publicKey),
  ];
  const adminAccountForFees = {
    scriptHash: strip0x(ADMIN_HASH),
    contract: {
      script: u.HexString.fromHex(
        wallet.getVerificationScriptFromPublicKey(publicKeyProbe.publicKey)
      ).toBase64(),
    },
  };
  transaction.networkFee = (
    await experimental.txHelpers.calculateNetworkFee(transaction, adminAccountForFees, {
      rpcAddress: rpcUrl,
    })
  ).add(u.BigInteger.fromNumber(100000));

  const finalSignature = await signWithDerivedAdmin(
    runtimeSignUrls,
    token,
    transaction.getMessageForSigning(networkMagic)
  );
  transaction.witnesses = [
    buildSignatureWitness(finalSignature.signature, finalSignature.publicKey),
  ];
  const witnessHash = normalizeHash160(`0x${transaction.witnesses[0].scriptHash}`);
  if (witnessHash !== ADMIN_HASH) {
    throw new Error(`admin witness hash mismatch: expected ${ADMIN_HASH}, got ${witnessHash}`);
  }

  return {
    txid: `0x${transaction.hash()}`,
    base64: Buffer.from(transaction.serialize(true), 'hex').toString('base64'),
    fees_raw: transaction.fees,
    system_fee_raw: transaction.systemFee.toString(),
    network_fee_raw: transaction.networkFee.toString(),
    rpcUrl,
  };
}

async function sendDerivedAdminTx(options) {
  const signed = await buildDerivedAdminTx(options);
  if (!EXECUTE) {
    return { broadcast: false, txid: signed.txid, fees_raw: signed.fees_raw };
  }
  await rpcPost(options.rpcUrl, 'sendrawtransaction', [signed.base64]);
  await assertHalt(options.rpcClient, signed.txid, options.operation);
  return { broadcast: true, txid: signed.txid, fees_raw: signed.fees_raw };
}

async function invokeLocalContract({
  rpcClient,
  rpcUrl,
  networkMagic,
  account,
  contractHash,
  operation,
  params,
  label,
}) {
  const contract = new experimental.SmartContract(contractHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  if (!EXECUTE) {
    const response = await contract.testInvoke(operation, params, [
      { account: account.scriptHash, scopes: 'CalledByEntry' },
    ]);
    if (String(response.state || '').toUpperCase() === 'FAULT') {
      throw new Error(`${label} test invoke faulted: ${response.exception || 'unknown error'}`);
    }
    return { broadcast: false, txid: null };
  }
  const txid = await contract.invoke(operation, params);
  await assertHalt(rpcClient, txid, label);
  return { broadcast: true, txid: txid.startsWith('0x') ? txid : `0x${txid}` };
}

async function ensureGasBalance({
  rpcClient,
  rpcUrl,
  networkMagic,
  fundingAccount,
  targetHash,
  minGasRaw,
  label,
}) {
  const before = await getGasBalanceRaw(rpcClient, targetHash);
  if (before >= minGasRaw) {
    return {
      action: 'skip',
      label,
      balance_gas: rawGasToDecimal(before),
      min_gas: rawGasToDecimal(minGasRaw),
    };
  }

  const amount = minGasRaw - before;
  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account: fundingAccount,
  });
  if (!EXECUTE) {
    const response = await gas.testInvoke('transfer', [
      sc.ContractParam.hash160(`0x${fundingAccount.scriptHash}`),
      sc.ContractParam.hash160(targetHash),
      sc.ContractParam.integer(amount.toString()),
      sc.ContractParam.any(null),
    ]);
    if (String(response.state || '').toUpperCase() === 'FAULT') {
      throw new Error(
        `${label} top-up test invoke faulted: ${response.exception || 'unknown error'}`
      );
    }
    return {
      action: 'topup-dry-run',
      label,
      amount_gas: rawGasToDecimal(amount),
      balance_gas: rawGasToDecimal(before),
      min_gas: rawGasToDecimal(minGasRaw),
    };
  }

  const txid = await gas.invoke('transfer', [
    sc.ContractParam.hash160(`0x${fundingAccount.scriptHash}`),
    sc.ContractParam.hash160(targetHash),
    sc.ContractParam.integer(amount.toString()),
    sc.ContractParam.any(null),
  ]);
  await assertHalt(rpcClient, txid, `${label} top-up`);
  return {
    action: 'topup',
    label,
    amount_gas: rawGasToDecimal(amount),
    balance_gas: rawGasToDecimal(await getGasBalanceRaw(rpcClient, targetHash)),
    min_gas: rawGasToDecimal(minGasRaw),
    txid: txid.startsWith('0x') ? txid : `0x${txid}`,
  };
}

async function ensureFeeCredit({
  rpcClient,
  rpcUrl,
  networkMagic,
  fundingAccount,
  oracleHash,
  beneficiaryHash,
  minCreditRaw,
}) {
  const before = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: beneficiaryHash },
    ])) || '0'
  );
  if (before >= minCreditRaw) {
    return {
      action: 'skip',
      beneficiary: beneficiaryHash,
      credit_raw: before.toString(),
      min_credit_raw: minCreditRaw.toString(),
    };
  }

  const amount = minCreditRaw - before;
  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account: fundingAccount,
  });
  const transferArgs = [
    sc.ContractParam.hash160(`0x${fundingAccount.scriptHash}`),
    sc.ContractParam.hash160(oracleHash),
    sc.ContractParam.integer(amount.toString()),
    sc.ContractParam.hash160(beneficiaryHash),
  ];

  if (!EXECUTE) {
    const response = await gas.testInvoke('transfer', transferArgs);
    if (String(response.state || '').toUpperCase() === 'FAULT') {
      throw new Error(`fee credit test invoke faulted: ${response.exception || 'unknown error'}`);
    }
    return {
      action: 'credit-dry-run',
      beneficiary: beneficiaryHash,
      amount_raw: amount.toString(),
      credit_raw: before.toString(),
      min_credit_raw: minCreditRaw.toString(),
    };
  }

  const txid = await gas.invoke('transfer', transferArgs);
  await assertHalt(rpcClient, txid, 'fee credit deposit');
  const after = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: beneficiaryHash },
    ])) || '0'
  );
  return {
    action: 'credit',
    beneficiary: beneficiaryHash,
    amount_raw: amount.toString(),
    credit_raw: after.toString(),
    min_credit_raw: minCreditRaw.toString(),
    txid: txid.startsWith('0x') ? txid : `0x${txid}`,
  };
}

async function ensureOracleKey(context) {
  const version = BigInt(
    (await invokeRead(context.rpcClient, context.oracleHash, 'oracleEncryptionKeyVersion')) || '0'
  );
  const publicKey = trimString(
    await invokeRead(context.rpcClient, context.oracleHash, 'oracleEncryptionPublicKey')
  );
  if (version > 0n && publicKey) {
    return { action: 'skip', version: version.toString(), public_key_present: true };
  }

  const runtimeKey = await fetchRuntimePublicKey(context.runtimeKeyUrls, context.token);
  const result = await sendDerivedAdminTx({
    ...context,
    contractHash: context.oracleHash,
    operation: 'setOracleEncryptionKey',
    params: [
      sc.ContractParam.string(runtimeKey.algorithm),
      sc.ContractParam.string(runtimeKey.publicKey),
    ],
  });
  return {
    action: result.broadcast ? 'set' : 'set-dry-run',
    source: runtimeKey.source,
    txid: result.txid,
    fees_raw: result.fees_raw,
  };
}

async function ensureRuntimeUpdater(context) {
  const runtimeUpdater = await fetchRuntimeDerivedNeoN3Key(
    context.runtimeKeyUrls,
    context.token,
    'updater'
  );
  const current = normalizeHash160(
    await invokeRead(context.rpcClient, context.oracleHash, 'updater')
  );
  if (current === runtimeUpdater.script_hash) {
    return {
      action: 'setUpdater-skip',
      updater: current,
      runtime_updater: runtimeUpdater.script_hash,
      key_path: runtimeUpdater.key_path,
    };
  }

  const result = await sendDerivedAdminTx({
    ...context,
    contractHash: context.oracleHash,
    operation: 'setUpdater',
    params: [sc.ContractParam.hash160(runtimeUpdater.script_hash)],
  });
  return {
    action: result.broadcast ? 'setUpdater' : 'setUpdater-dry-run',
    old_updater: current,
    new_updater: runtimeUpdater.script_hash,
    runtime_updater_address: runtimeUpdater.address,
    key_path: runtimeUpdater.key_path,
    txid: result.txid,
    fees_raw: result.fees_raw,
  };
}

async function ensureRuntimeVerifier(context) {
  const runtimeVerifier = await fetchRuntimeDerivedNeoN3Key(
    context.runtimeKeyUrls,
    context.token,
    'oracle_verifier'
  );
  const current = normalizePublicKeyOrEmpty(
    await invokeRead(context.rpcClient, context.oracleHash, 'oracleVerificationPublicKey')
  );
  if (current === runtimeVerifier.public_key) {
    return {
      action: 'setOracleVerificationPublicKey-skip',
      verifier_public_key: current,
      key_path: runtimeVerifier.key_path,
    };
  }

  const result = await sendDerivedAdminTx({
    ...context,
    contractHash: context.oracleHash,
    operation: 'setOracleVerificationPublicKey',
    params: [sc.ContractParam.publicKey(runtimeVerifier.public_key)],
  });
  return {
    action: result.broadcast
      ? 'setOracleVerificationPublicKey'
      : 'setOracleVerificationPublicKey-dry-run',
    old_verifier_public_key: current,
    new_verifier_public_key: runtimeVerifier.public_key,
    runtime_verifier_address: runtimeVerifier.address,
    key_path: runtimeVerifier.key_path,
    txid: result.txid,
    fees_raw: result.fees_raw,
  };
}

async function getMiniAppIds(rpcClient, oracleHash) {
  const ids = await invokeRead(rpcClient, oracleHash, 'getAllMiniAppIds');
  return Array.isArray(ids) ? ids.map(String) : [];
}

async function ensureSystemModule(context, module) {
  const moduleIds = await invokeRead(
    context.rpcClient,
    context.oracleHash,
    'getAllSystemModuleIds'
  );
  const existingIds = Array.isArray(moduleIds) ? moduleIds.map(String) : [];
  if (existingIds.includes(module.moduleId)) {
    return { action: 'module-skip', module_id: module.moduleId };
  }

  const register = await sendDerivedAdminTx({
    ...context,
    contractHash: context.oracleHash,
    operation: 'registerSystemModule',
    params: [
      sc.ContractParam.string(module.moduleId),
      sc.ContractParam.string(module.endpoint),
      sc.ContractParam.string(module.schemaHash),
    ],
  });
  return {
    action: register.broadcast ? 'module-register' : 'module-register-dry-run',
    module_id: module.moduleId,
    endpoint: module.endpoint,
    schema_hash: module.schemaHash,
    txid: register.txid,
    fees_raw: register.fees_raw,
  };
}

async function ensureMiniApp(context, app) {
  const existingIds = await getMiniAppIds(context.rpcClient, context.oracleHash);
  const actions = [];
  const appAlreadyExists = existingIds.includes(app.appId);
  if (!appAlreadyExists) {
    const register = await sendDerivedAdminTx({
      ...context,
      contractHash: context.oracleHash,
      operation: 'registerMiniApp',
      params: [
        sc.ContractParam.string(app.appId),
        sc.ContractParam.hash160(app.admin),
        sc.ContractParam.hash160(app.feePayer),
        sc.ContractParam.hash160(app.callbackContract),
        sc.ContractParam.string(app.metadataUri),
        sc.ContractParam.string(app.metadataHash),
      ],
    });
    actions.push({
      action: register.broadcast ? 'register' : 'register-dry-run',
      app_id: app.appId,
      txid: register.txid,
      fees_raw: register.fees_raw,
    });
  } else {
    actions.push({ action: 'register-skip', app_id: app.appId });
  }

  const modulesForApp =
    Array.isArray(app.moduleIds) && app.moduleIds.length > 0
      ? app.moduleIds
      : context.systemModules;
  for (const moduleId of modulesForApp) {
    if (!EXECUTE && context.pendingSystemModules?.has(moduleId)) {
      actions.push({
        action: 'grant-dry-run-after-module-register',
        app_id: app.appId,
        module_id: moduleId,
      });
      continue;
    }
    if (!EXECUTE && (!appAlreadyExists || context.contractUpdatePending)) {
      actions.push({
        action: context.contractUpdatePending
          ? 'grant-dry-run-after-update'
          : 'grant-dry-run-after-register',
        app_id: app.appId,
        module_id: moduleId,
      });
      continue;
    }
    const granted = Boolean(
      await invokeRead(context.rpcClient, context.oracleHash, 'isModuleGrantedToMiniApp', [
        { type: 'String', value: app.appId },
        { type: 'String', value: moduleId },
      ])
    );
    if (granted) {
      actions.push({ action: 'grant-skip', app_id: app.appId, module_id: moduleId });
      continue;
    }
    const grant = await sendDerivedAdminTx({
      ...context,
      contractHash: context.oracleHash,
      operation: 'grantModuleToMiniApp',
      params: [sc.ContractParam.string(app.appId), sc.ContractParam.string(moduleId)],
    });
    actions.push({
      action: grant.broadcast ? 'grant' : 'grant-dry-run',
      app_id: app.appId,
      module_id: moduleId,
      txid: grant.txid,
      fees_raw: grant.fees_raw,
    });
  }

  return actions;
}

async function ensureContractUpdate(context) {
  if (!UPDATE_CONTRACT) {
    return { action: 'update-skip', reason: 'not requested' };
  }

  const [nefBytes, manifestRaw, contractState] = await Promise.all([
    fs.readFile(path.resolve('contracts/build/MorpheusOracle.nef')),
    fs.readFile(path.resolve('contracts/build/MorpheusOracle.manifest.json'), 'utf8'),
    context.rpcClient.getContractState(context.oracleHash),
  ]);
  const localNef = sc.NEF.fromBuffer(nefBytes);
  const liveChecksum = Number(contractState.nef?.checksum || 0);
  const localChecksum = Number(localNef.checksum || 0);
  const liveManifestFingerprint = stableJsonStringify(contractState.manifest || {});
  const localManifestFingerprint = stableJsonStringify(JSON.parse(manifestRaw));
  const manifestChanged = liveManifestFingerprint !== localManifestFingerprint;
  if (liveChecksum === localChecksum && !manifestChanged) {
    return {
      action: 'update-skip',
      reason: 'deployed checksum already matches local build',
      checksum: localChecksum,
      update_counter: contractState.updatecounter,
    };
  }

  const result = await sendDerivedAdminTx({
    ...context,
    contractHash: context.oracleHash,
    operation: 'update',
    params: [
      sc.ContractParam.byteArray(u.HexString.fromHex(nefBytes.toString('hex'), true)),
      sc.ContractParam.string(manifestRaw),
    ],
  });
  return {
    action: result.broadcast ? 'update' : 'update-dry-run',
    old_checksum: liveChecksum,
    new_checksum: localChecksum,
    manifest_changed: manifestChanged,
    update_counter_before: contractState.updatecounter,
    txid: result.txid,
    fees_raw: result.fees_raw,
  };
}

async function ensureConsumerOracle(context, consumerHash) {
  const current = normalizeHash160(await invokeRead(context.rpcClient, consumerHash, 'oracle'));
  if (current === context.oracleHash) {
    return { action: 'skip', consumer: consumerHash, oracle: current };
  }
  const result = await invokeLocalContract({
    rpcClient: context.rpcClient,
    rpcUrl: context.rpcUrl,
    networkMagic: context.networkMagic,
    account: context.workerAccount,
    contractHash: consumerHash,
    operation: 'setOracle',
    params: [sc.ContractParam.hash160(context.oracleHash)],
    label: `setOracle ${consumerHash}`,
  });
  return {
    action: result.broadcast ? 'setOracle' : 'setOracle-dry-run',
    consumer: consumerHash,
    old_oracle: current,
    new_oracle: context.oracleHash,
    txid: result.txid,
  };
}

async function resolvePlatformGameHash() {
  const envHash = normalizeHash160(
    process.env.CONTRACT_PLATFORM_GAME_HASH_MAINNET ||
      process.env.PLATFORM_GAME_HASH_MAINNET ||
      process.env.CONTRACT_PLATFORM_GAME_HASH
  );
  if (envHash) return envHash;

  const candidates = [
    path.resolve('..', 'neo-os-contracts', 'contracts', 'build', 'mainnet_game_deployment.json'),
  ];
  for (const candidate of candidates) {
    const deployment = await loadJsonIfExists(candidate);
    const hash = normalizeHash160(deployment.platform_game || deployment.PlatformGame || '');
    if (hash) return hash;
  }
  return '';
}

async function main() {
  process.env.MORPHEUS_NETWORK = 'mainnet';
  await loadDotEnv();
  await loadDotEnv(path.resolve('deploy', 'nitro', 'morpheus.mainnet.env'), { override: true });

  const network = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || 'mainnet');
  if (network !== 'mainnet') throw new Error('this repair script only runs on mainnet');

  const networkConfig = await loadJsonIfExists(path.resolve('config', 'networks', 'mainnet.json'));
  const reviewedNetworkRegistry = readReviewedNetworkRegistrySync(process.cwd(), 'mainnet');
  const deployments = await loadJsonIfExists(
    path.resolve('examples', 'deployments', 'mainnet.json')
  );
  const rpcUrl = trimString(process.env.NEO_RPC_URL || networkConfig.neo_n3?.rpc_url || '');
  const networkMagic = Number(
    resolveReviewedNeoN3Magic(
      reviewedNetworkRegistry,
      'mainnet',
      process.env.NEO_NETWORK_MAGIC || networkConfig.neo_n3?.network_magic || ''
    )
  );
  const oracleHash = normalizeHash160(
    explicitContractEnv.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET ||
      explicitContractEnv.CONTRACT_MORPHEUS_ORACLE_HASH ||
      deployments.neo_n3?.oracle_hash ||
      networkConfig.neo_n3?.contracts?.morpheus_oracle ||
      process.env.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET ||
      process.env.CONTRACT_MORPHEUS_ORACLE_HASH
  );
  const callbackConsumerHash = normalizeHash160(
    explicitContractEnv.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH_MAINNET ||
      explicitContractEnv.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH ||
      networkConfig.neo_n3?.contracts?.oracle_callback_consumer ||
      process.env.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH_MAINNET ||
      process.env.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH
  );
  const exampleConsumerHash = normalizeHash160(
    deployments.neo_n3?.example_consumer_hash ||
      networkConfig.neo_n3?.examples?.oracle_callback_consumer
  );
  const runtimeUrl = trimString(
    process.env.MORPHEUS_MAINNET_RUNTIME_URL || process.env.MORPHEUS_RUNTIME_URL
  ).replace(/\/$/, '');
  const token = trimString(process.env.MORPHEUS_RUNTIME_TOKEN || process.env.NITRO_API_TOKEN);
  const runtimeRegistry = networkConfig.nitro;
  const runtimeKeyUrls = [
    trimString(process.env.MORPHEUS_PUBLIC_API_URL),
    trimString(runtimeRegistry?.public_api_url),
    runtimeUrl,
  ].filter(Boolean);
  const runtimeSignUrls = [
    trimString(process.env.MORPHEUS_SIGNING_URL),
    trimString(runtimeRegistry?.public_api_url),
    runtimeUrl,
  ].filter(Boolean);

  if (!rpcUrl) throw new Error('mainnet RPC URL is required');
  if (!oracleHash) throw new Error('mainnet MorpheusOracle hash is required');
  if (!callbackConsumerHash) throw new Error('mainnet callback consumer hash is required');
  if (!exampleConsumerHash) throw new Error('mainnet example consumer hash is required');
  if (!runtimeUrl)
    throw new Error('MORPHEUS_MAINNET_RUNTIME_URL or MORPHEUS_RUNTIME_URL is required');
  if (!token) throw new Error('MORPHEUS_RUNTIME_TOKEN or NITRO_API_TOKEN is required');

  const workerSigner = resolvePinnedNeoN3Role('mainnet', 'worker', { env: process.env });
  const workerSecret =
    workerSigner.materialized?.wif || workerSigner.materialized?.private_key || '';
  const workerAccount = new wallet.Account(workerSecret);
  const workerHash = normalizeHash160(`0x${workerAccount.scriptHash}`);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);
  const systemModules = (await invokeRead(rpcClient, oracleHash, 'getAllSystemModuleIds')).map(
    String
  );
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee')) || '0');
  const adminMinGasRaw = parseGasToRaw(process.env.MORPHEUS_MAINNET_ADMIN_MIN_GAS, 50000000n);
  const workerMinGasRaw = parseGasToRaw(process.env.MORPHEUS_MAINNET_WORKER_MIN_GAS, 30000000n);
  const creditRequestCount = BigInt(
    trimString(process.env.MORPHEUS_MAINNET_REQUEST_CREDIT_REQUESTS) || DEFAULT_CREDIT_REQUESTS
  );
  const minCreditRaw = requestFee > 0n ? requestFee * creditRequestCount : 0n;

  const context = {
    rpcClient,
    rpcUrl,
    networkMagic,
    runtimeSignUrls,
    runtimeKeyUrls,
    token,
    oracleHash,
    workerAccount,
    workerHash,
    systemModules,
  };
  const platformGameHash = await resolvePlatformGameHash();
  const apps = [
    {
      appId: 'morpheus.callback.consumer',
      admin: workerHash,
      feePayer: workerHash,
      callbackContract: callbackConsumerHash,
      metadataUri: DEFAULT_METADATA_URI,
      metadataHash: 'mainnet-callback-consumer-v1',
      moduleIds: systemModules,
    },
    {
      appId: 'morpheus.examples.consumer',
      admin: workerHash,
      feePayer: workerHash,
      callbackContract: exampleConsumerHash,
      metadataUri: DEFAULT_METADATA_URI,
      metadataHash: 'mainnet-example-consumer-v1',
      moduleIds: systemModules,
    },
  ];
  if (platformGameHash) {
    apps.push({
      appId: PLATFORM_GAME_APP_ID,
      admin: ADMIN_HASH,
      feePayer: ADMIN_HASH,
      callbackContract: platformGameHash,
      metadataUri: DEFAULT_METADATA_URI,
      metadataHash: 'mainnet-platform-game-callback-v1',
      moduleIds: [PLATFORM_GAME_MODULE.moduleId],
    });
  }

  const report = {
    mode: EXECUTE ? 'execute' : 'dry-run',
    oracle_hash: oracleHash,
    admin_hash: ADMIN_HASH,
    worker_hash: workerHash,
    platform_game_hash: platformGameHash || null,
    callback_consumer_hash: callbackConsumerHash,
    example_consumer_hash: exampleConsumerHash,
    rpc_url: rpcUrl,
    request_fee_raw: requestFee.toString(),
    system_modules: systemModules,
    actions: [],
  };

  report.actions.push(
    await ensureGasBalance({
      rpcClient,
      rpcUrl,
      networkMagic,
      fundingAccount: workerAccount,
      targetHash: workerHash,
      minGasRaw: workerMinGasRaw,
      label: 'worker',
    })
  );
  report.actions.push(
    await ensureGasBalance({
      rpcClient,
      rpcUrl,
      networkMagic,
      fundingAccount: workerAccount,
      targetHash: ADMIN_HASH,
      minGasRaw: adminMinGasRaw,
      label: 'derived-admin',
    })
  );
  report.actions.push(await ensureRuntimeUpdater(context));
  report.actions.push(await ensureRuntimeVerifier(context));
  report.actions.push(await ensureOracleKey(context));
  const updateAction = await ensureContractUpdate(context);
  report.actions.push(updateAction);
  context.contractUpdatePending = !EXECUTE && updateAction.action === 'update-dry-run';
  if (platformGameHash) {
    const moduleAction = await ensureSystemModule(context, PLATFORM_GAME_MODULE);
    report.actions.push(moduleAction);
    if (!EXECUTE && moduleAction.action === 'module-register-dry-run') {
      context.pendingSystemModules = new Set([
        ...(context.pendingSystemModules || []),
        PLATFORM_GAME_MODULE.moduleId,
      ]);
    }
    context.systemModules = Array.from(
      new Set(
        (await invokeRead(rpcClient, oracleHash, 'getAllSystemModuleIds'))
          .map(String)
          .concat(PLATFORM_GAME_MODULE.moduleId)
      )
    );
  }
  for (const app of apps) {
    report.actions.push(...(await ensureMiniApp(context, app)));
  }
  report.actions.push(await ensureConsumerOracle(context, callbackConsumerHash));
  report.actions.push(await ensureConsumerOracle(context, exampleConsumerHash));
  if (!SKIP_CREDIT && minCreditRaw > 0n) {
    const creditBeneficiaries = Array.from(
      new Set([workerHash, ...apps.map((app) => app.feePayer)])
    );
    for (const beneficiaryHash of creditBeneficiaries) {
      report.actions.push(
        await ensureFeeCredit({
          rpcClient,
          rpcUrl,
          networkMagic,
          fundingAccount: workerAccount,
          oracleHash,
          beneficiaryHash,
          minCreditRaw,
        })
      );
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (!EXECUTE) {
    console.error(
      'Dry run only. Re-run with --execute to broadcast the required mainnet transactions.'
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
