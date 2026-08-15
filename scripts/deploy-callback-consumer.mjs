import { deployContract } from './lib-neo-contracts.mjs';

const txHash = await deployContract('OracleCallbackConsumer');
console.log(`OracleCallbackConsumer deploy tx: ${txHash}`);
