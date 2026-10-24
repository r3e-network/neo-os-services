import { sc, tx, u, wallet } from '@cityofzion/neon-js';
import { sponsorshipApprovalDigest } from '../paymaster/approvals.js';

export function buildSponsorshipFixture({
  id = 'approval-1',
  feePerByte = 1000,
  priorityFee = 100000,
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
} = {}) {
  const userAccount = new wallet.Account('11'.repeat(32));
  const sponsorAccount = new wallet.Account('22'.repeat(32));
  const targetContract = `0x${'aa'.repeat(20)}`;
  const method = 'transfer';
  const transaction = new tx.Transaction({
    nonce: 1,
    validUntilBlock: 100,
    signers: [{ account: userAccount.scriptHash, scopes: tx.WitnessScope.CalledByEntry }],
    script: new sc.ScriptBuilder().emitAppCall(targetContract, method, []).build(),
  });
  const finalTransaction = tx.Transaction.deserialize(transaction.serialize(true));
  finalTransaction.signers.push(
    new tx.Signer({ account: sponsorAccount.scriptHash, scopes: tx.WitnessScope.None })
  );
  const sponsorPlaceholder = new tx.Witness({
    invocationScript: '0c40' + '00'.repeat(64),
    verificationScript: `0c21${sponsorAccount.publicKey}4156e7b327`,
  });
  const dummySignatures = finalTransaction.signers.map((signer) =>
    String(signer.account) === sponsorAccount.scriptHash
      ? sponsorPlaceholder
      : new tx.Witness({ invocationScript: '', verificationScript: '' })
  );
  const size =
    finalTransaction.serialize().length / 2 +
    dummySignatures.reduce((sum, witness) => sum + witness.serialize().length / 2, 0);
  const networkFee = size * feePerByte + priorityFee;
  finalTransaction.networkFee = u.BigInteger.fromNumber(networkFee);
  const operationHash = `0x${finalTransaction.hash().replace(/^0x/i, '').toLowerCase()}`;
  const approval = {
    mode: 'paymaster_authorize',
    approved: true,
    network: 'testnet',
    target_chain: 'neo_n3',
    policy_id: 'shared-test-policy',
    sponsorship_id: id,
    account_id: `0x${userAccount.scriptHash}`.toLowerCase(),
    dapp_id: 'demo-dapp',
    target_contract: targetContract,
    method,
    userop_target_contract: '',
    userop_method: '',
    estimated_gas_units: networkFee,
    operation_hash: operationHash,
    expires_at: expiresAt,
    policy: { policy_id: 'shared-test-policy', max_gas_units: networkFee },
    onchain_policy: null,
  };
  approval.approval_digest = sponsorshipApprovalDigest(approval);
  return {
    approval,
    feePerByte,
    priorityFee,
    networkFee,
    operationHash,
    sponsorAccount,
    userAccount,
    targetContract,
    method,
    transaction,
    finalTransaction,
  };
}

export function sponsorshipPayload(fixture, overrides = {}) {
  return {
    ...fixture.approval,
    tx_base64: fixture.transaction.serialize(true),
    user_address: fixture.userAccount.address,
    fee_per_byte: fixture.feePerByte,
    priority_fee: fixture.priorityFee,
    ...overrides,
  };
}

export function sponsorshipStorageKey(id) {
  return `morpheus:paymaster:approval:${id}`;
}
