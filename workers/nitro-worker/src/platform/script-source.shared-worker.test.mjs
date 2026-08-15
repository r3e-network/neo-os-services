import test from 'node:test';
import assert from 'node:assert/strict';
import { rpc as neoRpc } from '@cityofzion/neon-js';

const ORIGINALS = {
  NEO_RPC_URL: process.env.NEO_RPC_URL,
  NEO_RPC_URL_MAINNET: process.env.NEO_RPC_URL_MAINNET,
  NEO_RPC_URL_TESTNET: process.env.NEO_RPC_URL_TESTNET,
};
const originalInvokeFunction = neoRpc.RPCClient.prototype.invokeFunction;

test.afterEach(() => {
  neoRpc.RPCClient.prototype.invokeFunction = originalInvokeFunction;
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('resolveScriptSource uses the request network to choose the Neo RPC URL', async () => {
  delete process.env.NEO_RPC_URL;
  process.env.NEO_RPC_URL_MAINNET = 'https://mainnet.rpc.test';
  process.env.NEO_RPC_URL_TESTNET = 'https://testnet.rpc.test';

  let observedRpcUrl = null;
  neoRpc.RPCClient.prototype.invokeFunction = async function invokeFunction() {
    observedRpcUrl = this.url;
    return {
      state: 'HALT',
      stack: [{ type: 'String', value: 'return 1;' }],
    };
  };

  const { resolveScriptSource } = await import(`./script-source.js?shared-worker=${Date.now()}`);
  const script = await resolveScriptSource({
    network: 'mainnet',
    script_ref: {
      contract_hash: '0x1111111111111111111111111111111111111111',
      script_name: 'demo',
    },
  });

  assert.equal(observedRpcUrl, 'https://mainnet.rpc.test');
  assert.equal(script, 'return 1;');
});
