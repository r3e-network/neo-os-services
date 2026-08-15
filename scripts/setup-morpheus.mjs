import { sc } from '@cityofzion/neon-js';
import { createContract } from './lib-neo-contracts.mjs';

const oracleHash = process.env.CONTRACT_MORPHEUS_ORACLE_HASH || '';
const consumerHash = process.env.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH || '';
const updater = process.env.MORPHEUS_UPDATER_HASH || '';

if (!oracleHash) throw new Error('CONTRACT_MORPHEUS_ORACLE_HASH is required');
if (!consumerHash) throw new Error('CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH is required');

const oracle = createContract(oracleHash);
const consumer = createContract(consumerHash);

console.log('Allowing callback consumer on MorpheusOracle...');
await oracle.invoke('addAllowedCallback', [sc.ContractParam.hash160(consumerHash)]);
console.log('Setting callback consumer oracle reference...');
await consumer.invoke('setOracle', [sc.ContractParam.hash160(oracleHash)]);

if (updater) {
  console.log('Setting updater...');
  await oracle.invoke('setUpdater', [sc.ContractParam.hash160(updater)]);
}

console.log('NeoOS Oracle contracts configured.');
