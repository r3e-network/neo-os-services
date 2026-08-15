import { deployContract } from './lib-neo-contracts.mjs';

const txHash = await deployContract('MorpheusOracle');
console.log(`MorpheusOracle deploy tx: ${txHash}`);
