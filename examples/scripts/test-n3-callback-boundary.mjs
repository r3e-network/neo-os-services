import { rpc as neoRpc, sc, tx, u, wallet } from '@cityofzion/neon-js';
import {
  loadExampleEnv,
  readDeploymentRegistry,
  resolveNeoN3SignerWif,
  sleep,
  trimString,
  writeValidationArtifacts,
} from './common.mjs';

function normalizeHash160(value = '') {
  const raw = trimString(value).replace(/^0x/i, '').toLowerCase();
  return raw ? `0x${raw}` : '';
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function buildInvokeScript({
  consumerHash,
  requestId,
  requestType,
  success,
  resultText,
  errorText,
}) {
  return sc.createScript({
    scriptHash: consumerHash.replace(/^0x/i, ''),
    operation: 'onOracleResult',
    args: [
      sc.ContractParam.integer(requestId),
      sc.ContractParam.string(requestType),
      sc.ContractParam.boolean(success),
      sc.ContractParam.byteArray(
        u.HexString.fromHex(Buffer.from(resultText, 'utf8').toString('hex'), true)
      ),
      sc.ContractParam.string(errorText),
    ],
  });
}

async function waitForAppLog(client, txid, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const appLog = await client.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch {
      // still waiting
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for application log for ${txid}`);
}

async function main() {
  await loadExampleEnv();
  const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet').toLowerCase() || 'testnet';
  assertCondition(network === 'testnet', 'this boundary probe is intended for Neo N3 testnet');

  const deployment = await readDeploymentRegistry('testnet');
  const neoN3 = deployment.neo_n3 || {};
  const rpcUrl = trimString(
    neoN3.rpc_url || process.env.NEO_RPC_URL || 'https://testnet1.neo.coz.io:443'
  );
  const consumerHash = normalizeHash160(neoN3.example_consumer_hash || '');
  const oracleHash = normalizeHash160(neoN3.oracle_hash || '');
  const signerWif = resolveNeoN3SignerWif('testnet');

  assertCondition(signerWif, 'testnet Neo N3 signer WIF is required');
  assertCondition(
    consumerHash,
    'example_consumer_hash is required in examples/deployments/testnet.json'
  );
  assertCondition(oracleHash, 'oracle_hash is required in examples/deployments/testnet.json');

  const account = new wallet.Account(signerWif);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);
  const version = await rpcClient.getVersion();
  const networkMagic = Number(version.protocol.network);

  const requestId = 999001;
  const requestType = 'oracle';
  const script = buildInvokeScript({
    consumerHash,
    requestId,
    requestType,
    success: true,
    resultText: 'forged-result',
    errorText: '',
  });
  const signers = [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }];

  const preview = await rpcClient.invokeScript(u.HexString.fromHex(script), signers);
  assertCondition(
    String(preview?.state || '').includes('FAULT'),
    'preview should FAULT for unauthorized direct callback injection'
  );
  assertCondition(
    /unauthorized caller/i.test(String(preview?.exception || '')),
    'preview should fail with unauthorized caller'
  );

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
  const appLog = await waitForAppLog(rpcClient, txid);
  const execution = appLog?.executions?.[0] || {};
  const vmState = String(execution.vmstate || execution.state || '');
  const exception = String(execution.exception || '');

  assertCondition(vmState.includes('FAULT'), 'persisted unauthorized direct callback should FAULT');
  assertCondition(
    /unauthorized caller/i.test(exception),
    'persisted unauthorized direct callback should fail with unauthorized caller'
  );

  const generatedAt = new Date().toISOString();
  const jsonReport = {
    generated_at: generatedAt,
    network: 'testnet',
    rpc_url: rpcUrl,
    network_magic: networkMagic,
    attacker_address: account.address,
    attacker_script_hash: normalizeHash160(account.scriptHash),
    oracle_hash: oracleHash,
    callback_consumer_hash: consumerHash,
    probe: {
      title: 'Direct external onOracleResult call should fault',
      txid,
      request_id: String(requestId),
      request_type: requestType,
      preview_state: preview?.state || '',
      preview_exception: preview?.exception || '',
      system_fee: preview?.gasconsumed || '0',
      network_fee: String(networkFee),
      vmstate: vmState,
      exception,
    },
  };

  const markdownReport = [
    '# N3 Callback Boundary Validation',
    '',
    `Date: ${generatedAt}`,
    '',
    '## Scope',
    '',
    'This probe validates that a normal external Neo N3 account cannot directly inject a forged `onOracleResult` callback into the configured testnet callback consumer.',
    '',
    '## Inputs',
    '',
    `- Oracle hash: \`${oracleHash}\``,
    `- Callback consumer hash: \`${consumerHash}\``,
    `- Attacker address: \`${account.address}\``,
    `- RPC: \`${rpcUrl}\``,
    '',
    '## Result',
    '',
    `- Probe txid: \`${txid}\``,
    `- Preview state: \`${preview?.state || ''}\``,
    `- Preview exception: \`${preview?.exception || ''}\``,
    `- Persisted vmstate: \`${vmState}\``,
    `- Persisted exception: \`${exception}\``,
    '',
    '## Conclusion',
    '',
    'The callback consumer rejected the forged direct external callback with `unauthorized caller`, which confirms that callback acceptance remains bound to the configured Oracle contract rather than a generic caller witness.',
    '',
  ].join('\n');

  const artifactPaths = await writeValidationArtifacts({
    baseName: 'n3-callback-boundary',
    network: 'testnet',
    generatedAt,
    jsonReport,
    markdownReport,
  });

  console.log(
    JSON.stringify(
      {
        ...artifactPaths,
        txid,
        callback_consumer_hash: consumerHash,
        oracle_hash: oracleHash,
        vmstate: vmState,
        exception,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
