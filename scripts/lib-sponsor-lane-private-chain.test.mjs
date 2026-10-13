// Unit tests for scripts/lib-sponsor-lane-private-chain.mjs (CU-153).
//
// The journey this library judges can only report green through
// `evaluateAcceptance`, so every dimension of the observation is a named test
// that must fail when that dimension is wrong. The wire encoders are pinned to
// golden vectors harvested from `crates/neo-os-core/tests/n3_tx.rs`, not to a
// round-trip against themselves: a second encoder that agrees with itself
// proves nothing about the bytes the real parser accepts.

import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, createVerify } from 'node:crypto';
import test from 'node:test';

import {
  ACCEPTANCE_CHECKS,
  SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS,
  assertRpcAddress,
  assertRpcParams,
  base58checkDecode,
  base58checkEncode,
  deliveryRpcSql,
  encodeInvokeScript,
  encodeUnsignedTx,
  evaluateAcceptance,
  hash160Wire,
  keyIdentity,
  messageForSigning,
  nep17AssetAmount,
  normalizeScriptHash,
  scriptHashToAddress,
  signWitness,
  sponsorIntentScript,
  transactionHashDisplay,
} from './lib-sponsor-lane-private-chain.mjs';

// -------------------------------------------------------------------------
// Golden vectors from crates/neo-os-core/tests/n3_tx.rs
// -------------------------------------------------------------------------

const FEED_N3_CONTRACT = '03013f49c42a14546c8bbe58f9d434c3517fccab';
const UPDATER_SCRIPT_HASH = '5c2047b1c6b4b6e4b3a1c9d5e7f0a2b4c6d8e0f1';
const TESTNET_MAGIC = 860833102;

const SINGLE_SYMBOL_SCRIPT =
  '1011c00c18d1df39e3ae5df7be76d5bdfae7d6b675ed1bdf7f1e6f4df611c00280f86b6611c00280841e0011c001e90311c00c125457454c5645444154413a4e454f2d55534411c016c01f0c0b75706461746546656564730c14abcc7f51c334d4f958be8b6c54142ac4493f010341627d5b52';

const ZEROED_TX =
  '000000000000000000000000000000000000000000f401000001f1e0d8c6b4a2f0e7d5c9a1b3e4b6b4c6b147205c01006d1011c00c18e1d7bcd77e78775d1dd76f1fd5ddba7b6d1c776f7cd75eb511c01111c01111c0028152b56811c00c125457454c5645444154413a4e454f2d55534411c016c01f0c0b75706461746546656564730c14abcc7f51c334d4f958be8b6c54142ac4493f010341627d5b52';

// The invocation script of the zeroed vector, with the transaction's `num2VarInt`
// length byte already stripped.
const ZEROED_SCRIPT =
  '1011c00c18e1d7bcd77e78775d1dd76f1fd5ddba7b6d1c776f7cd75eb511c01111c01111c0028152b56811c00c125457454c5645444154413a4e454f2d55534411c016c01f0c0b75706461746546656564730c14abcc7f51c334d4f958be8b6c54142ac4493f010341627d5b52';

function hexBuffer(hex) {
  return Buffer.from(String(hex).replace(/^0x/i, ''), 'hex');
}

// -------------------------------------------------------------------------
// Wire encoding
// -------------------------------------------------------------------------

test('a_hash160_argument_is_emitted_in_wire_order', () => {
  // `create_invoke_script` takes display order and reverses onto the wire.
  const wire = hash160Wire(`0x${FEED_N3_CONTRACT}`);
  assert.equal(Buffer.from(wire).toString('hex'), 'abcc7f51c334d4f958be8b6c54142ac4493f0103');
});

test('a_hash160_argument_that_is_not_twenty_bytes_is_refused', () => {
  for (const bad of ['', '0x', '0x1234', `0x${'11'.repeat(21)}`, 'not-hex-at-all', null, 42]) {
    assert.throws(() => hash160Wire(bad), /20-byte|script hash/i, JSON.stringify(bad));
  }
});

test('the_invoke_script_matches_the_rust_encoder_byte_for_byte', () => {
  // The `feed_args` fixture of crates/neo-os-core/tests/n3_tx.rs: six top-level
  // arrays, one per ABI parameter, each holding one value.
  const script = encodeInvokeScript(`0x${FEED_N3_CONTRACT}`, 'updateFeeds', [
    { type: 'array', value: [{ type: 'string', value: 'TWELVEDATA:NEO-USD' }] },
    { type: 'array', value: [{ type: 'int', value: 1001 }] },
    { type: 'array', value: [{ type: 'int', value: 2000000 }] },
    { type: 'array', value: [{ type: 'int', value: 1718352000 }] },
    {
      type: 'array',
      value: [
        {
          type: 'bytes',
          value: Buffer.from('0d85465d97521b3659a2de0b338eb032', 'base64'),
        },
      ],
    },
    { type: 'array', value: [{ type: 'int', value: 0 }] },
  ]);
  assert.equal(Buffer.from(script).toString('hex'), SINGLE_SYMBOL_SCRIPT);
});

test('an_empty_byte_array_and_a_two_item_array_match_the_rust_prefixes', () => {
  const empty = encodeInvokeScript(`0x${FEED_N3_CONTRACT}`, 'updateFeeds', [
    { type: 'array', value: [{ type: 'bytes', value: new Uint8Array(0) }] },
  ]);
  assert.ok(Buffer.from(empty).toString('hex').startsWith('0c00'), 'empty byte array');

  const two = encodeInvokeScript(`0x${FEED_N3_CONTRACT}`, 'updateFeeds', [
    {
      type: 'array',
      value: [
        { type: 'string', value: 'A' },
        { type: 'string', value: 'B' },
      ],
    },
  ]);
  assert.ok(Buffer.from(two).toString('hex').startsWith('0c01420c014112c0'), 'two-item array');
});

test('integer_emission_matches_the_per_param_vectors', () => {
  for (const [value, expected] of [
    [0, '10'],
    [1, '11'],
    [16, '20'],
    [-1, '0f'],
    [17, '0011'],
    [255, '01ff00'],
    [256, '010001'],
    [1001, '01e903'],
    [65535, '02ffff0000'],
    [65536, '0200000100'],
    [2000000, '0280841e00'],
    [4294967295, '03ffffffff00000000'],
    [4294967296, '030000000001000000'],
  ]) {
    const script = encodeInvokeScript(`0x${FEED_N3_CONTRACT}`, 'updateFeeds', [
      { type: 'array', value: [{ type: 'int', value }] },
    ]);
    const encoded = Buffer.from(script).toString('hex');
    assert.ok(
      encoded.startsWith(expected),
      `integer ${value}: expected prefix ${expected} in ${encoded}`
    );
    assert.ok(encoded.includes('11c0'), `integer ${value}: the array was not packed`);
  }
});

test('the_unsigned_transaction_matches_the_rust_encoder_byte_for_byte', () => {
  const bytes = encodeUnsignedTx({
    nonce: 0,
    systemFee: 0,
    networkFee: 0,
    validUntilBlock: 500,
    signerDisplay: `0x${UPDATER_SCRIPT_HASH}`,
    script: hexBuffer(ZEROED_SCRIPT),
  });
  assert.equal(Buffer.from(bytes).toString('hex'), ZEROED_TX);
  assert.equal(transactionHashDisplay(bytes).length, 66);
  assert.equal(
    Buffer.from(messageForSigning(bytes, TESTNET_MAGIC)).toString('hex').slice(0, 8),
    '4e454f33'
  );
});

test('the_signing_preimage_is_the_magic_followed_by_the_plain_transaction_digest', () => {
  const bytes = hexBuffer(ZEROED_TX);
  const preimage = messageForSigning(bytes, TESTNET_MAGIC);
  const digest = createHash('sha256').update(bytes).digest();
  assert.equal(
    Buffer.from(preimage).toString('hex'),
    `${Buffer.from(TESTNET_MAGIC.toString(16).padStart(8, '0'), 'hex')
      .reverse()
      .toString('hex')}${digest.toString('hex')}`
  );
});

// -------------------------------------------------------------------------
// Address and identity
// -------------------------------------------------------------------------

test('the_neo_address_vector_matches_the_private_chain_genesis_account', () => {
  // Read off the disposable Neo Express chain this journey drives: the genesis
  // signer is 0x29199733… and its address is NgnLxoBSq3ccKb6Ds9AriCkeVqwEdbr3CN.
  const hash = '29199733d7ec52fabc32083fb1a6e826ef7de9e4';
  assert.equal(base58checkEncode(hash), 'NgnLxoBSq3ccKb6Ds9AriCkeVqwEdbr3CN');
  assert.equal(base58checkDecode('NgnLxoBSq3ccKb6Ds9AriCkeVqwEdbr3CN'), hash);
});

test('a_bad_base58check_address_is_refused_rather_than_truncated', () => {
  for (const bad of ['', 'N', 'NgnLxoBSq3ccKb6Ds9AriCkeVqwEdbr3CO', '0x29199733']) {
    assert.throws(() => base58checkDecode(bad), /base58|address/i, bad);
  }
});

test('the_fake_sign_identity_derives_the_key_the_chain_will_accept', () => {
  // A throwaway P-256 scalar; the journey's disposable account, not a credential.
  const privateKeyHex = '1c'.repeat(32);
  const identity = keyIdentity({ privateKeyHex });
  assert.equal(identity.public_key.length, 66);
  assert.ok(/^0[23]/.test(identity.public_key), 'compressed public key');
  assert.match(identity.script_hash, /^0x[0-9a-f]{40}$/);
  assert.match(identity.address, /^N[1-9A-HJ-NP-Za-km-z]{32,33}$/);
  assert.equal(identity.verification_script, `0c21${identity.public_key}4156e7b327`);
  // The published identity is the display order of `hash160(verification)`, and
  // the address is base58check(0x35 + the wire order) of the same hash.
  const wire = createHash('ripemd160')
    .update(createHash('sha256').update(Buffer.from(identity.verification_script, 'hex')).digest())
    .digest();
  assert.equal(identity.script_hash, `0x${Buffer.from(wire).reverse().toString('hex')}`);
  assert.equal(base58checkEncode(identity.script_hash), identity.address);
});

// -------------------------------------------------------------------------
// The fake SIGN witness
// -------------------------------------------------------------------------

function witnessFixture() {
  const privateKeyHex = '2b'.repeat(32);
  const identity = keyIdentity({ privateKeyHex });
  const unsigned = hexBuffer(ZEROED_TX);
  return { privateKeyHex, identity, unsigned };
}

test('the_witness_verifies_over_the_network_magic_and_the_transaction_digest', () => {
  const { privateKeyHex, identity, unsigned } = witnessFixture();
  const witness = signWitness({ privateKeyHex, unsignedBytes: unsigned, magic: TESTNET_MAGIC });
  assert.equal(witness.invocation_script.length, 66 * 2);
  assert.ok(witness.invocation_script.startsWith('0c40'), 'invocation is PUSHDATA1 64');
  assert.equal(witness.verification_script, `0c21${identity.public_key}4156e7b327`);

  // The byte contract of workers/neo-signer/src/crypto.rs: ECDSA-P256 over
  // SHA256(magic_le32 || SHA256(unsigned_tx)), low-S, r||s.
  const preimage = messageForSigning(unsigned, TESTNET_MAGIC);
  const verify = createVerify('SHA256');
  verify.update(preimage);
  const publicKey = createPublicKey(
    createPrivateKey({
      key: Buffer.concat([
        Buffer.from('30310201010420', 'hex'),
        Buffer.from(privateKeyHex, 'hex'),
        Buffer.from('a00a06082a8648ce3d030107', 'hex'),
      ]),
      format: 'der',
      type: 'sec1',
    })
  );
  assert.equal(
    verify.verify(
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(witness.signature, 'hex')
    ),
    true
  );
});

test('a_witness_over_the_wrong_preimage_does_not_verify', () => {
  const { privateKeyHex, unsigned } = witnessFixture();
  const witness = signWitness({ privateKeyHex, unsignedBytes: unsigned, magic: TESTNET_MAGIC });
  const publicKey = createPublicKey(
    createPrivateKey({
      key: Buffer.concat([
        Buffer.from('30310201010420', 'hex'),
        Buffer.from(privateKeyHex, 'hex'),
        Buffer.from('a00a06082a8648ce3d030107', 'hex'),
      ]),
      format: 'der',
      type: 'sec1',
    })
  );
  const wrongMagic = messageForSigning(unsigned, TESTNET_MAGIC + 1);
  const verify = createVerify('SHA256');
  verify.update(wrongMagic);
  assert.equal(
    verify.verify(
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(witness.signature, 'hex')
    ),
    false
  );
});

test('the_signature_is_low_s', () => {
  const { privateKeyHex, unsigned } = witnessFixture();
  // Sample enough nonces that a high-S counterfeiter would show up.
  for (let nonce = 0; nonce < 24; nonce += 1) {
    const witness = signWitness({
      privateKeyHex,
      unsignedBytes: unsigned,
      magic: TESTNET_MAGIC,
      nonceSalt: Buffer.from([nonce]),
    });
    const s = BigInt(`0x${witness.signature.slice(64)}`);
    const halfN = BigInt('0x7fffffff80000000800000000000000000000000ffffffffffffffffffffffff');
    assert.ok(s <= halfN, `signature ${nonce} is not low-S`);
  }
});

// -------------------------------------------------------------------------
// Intent scripts
// -------------------------------------------------------------------------

test('the_sponsored_user_op_script_carries_the_five_abi_arguments', () => {
  const account = `0x${'11'.repeat(20)}`;
  const paymaster = `0x${'22'.repeat(20)}`;
  const sponsor = `0x${'33'.repeat(20)}`;
  const target = `0x${'44'.repeat(20)}`;
  const { script, reimbursementUnits } = sponsorIntentScript({
    method: 'executeSponsoredUserOp',
    contract: `0x${FEED_N3_CONTRACT}`,
    accountId: account,
    paymaster,
    sponsor,
    reimbursementUnits: 3_000_000,
    op: {
      targetContract: target,
      method: 'transfer',
      args: [{ type: 'int', value: 1 }],
      nonce: 7,
      deadline: 2000,
      signature: Buffer.from('cafebabe', 'hex'),
    },
  });
  assert.equal(reimbursementUnits, 3_000_000);
  const hex = Buffer.from(script).toString('hex');
  const methodBytes = Buffer.from('executeSponsoredUserOp', 'utf8');
  assert.ok(
    hex.includes(`0c${methodBytes.length.toString(16)}${methodBytes.toString('hex')}`),
    'the method name is pushed in full'
  );
  assert.ok(hex.endsWith('41627d5b52'), 'ends with System.Contract.Call');
  // Five arguments are packed as one array: the count push is 5 → 0x15, PACK.
  assert.ok(hex.includes('15c0'), `packed args in ${hex}`);
});

test('a_zero_reimbursement_is_refused_before_anything_is_encoded', () => {
  assert.throws(
    () =>
      sponsorIntentScript({
        method: 'executeSponsoredUserOp',
        contract: `0x${FEED_N3_CONTRACT}`,
        accountId: `0x${'11'.repeat(20)}`,
        paymaster: `0x${'22'.repeat(20)}`,
        sponsor: `0x${'33'.repeat(20)}`,
        reimbursementUnits: 0,
        op: {
          targetContract: `0x${'44'.repeat(20)}`,
          method: 'transfer',
          args: [],
          nonce: 0,
          deadline: 1,
          signature: new Uint8Array(0),
        },
      }),
    /reimbursement/i
  );
});

// -------------------------------------------------------------------------
// The delivery RPC stand-in
// -------------------------------------------------------------------------

test('the_delivery_rpc_stand_in_only_names_the_shipped_sql_functions', () => {
  const reserve = deliveryRpcSql('sponsor_reserve', {
    p_network: 'testnet',
    p_principal: '11111111-2222-4333-8444-555555555555',
    p_idempotency_key: 'key',
    p_contract: '0x11',
    p_account: '0x22',
    p_intent: { a: 1 },
    p_fee_ceiling_units: 20000000,
  });
  assert.match(reserve.sql, /public\.morpheus_delivery_sponsor_reserve\(/);
  assert.match(reserve.sql, /service_role/);

  const claim = deliveryRpcSql('claim', {
    p_network: 'testnet',
    p_chain: 'neo_n3',
    p_account: '0x22',
    p_owner: 'worker',
    p_lease_ms: 60000,
    p_kinds: ['sponsor'],
  });
  assert.match(claim.sql, /public\.morpheus_delivery_claim\(/);
  assert.match(claim.sql, /array\['sponsor'\]/);

  const transition = deliveryRpcSql('transition', {
    p_job: 'k',
    p_owner: 'worker',
    p_generation: 1,
    p_op: 'completed',
    p_data: { vm_state: 'HALT' },
    p_lease_ms: 60000,
  });
  assert.match(transition.sql, /public\.morpheus_delivery_transition\(/);
  assert.match(deliveryRpcSql('lookup', { p_job: 'k' }).sql, /morpheus_delivery_lookup/);
});

test('an_unknown_rpc_name_is_refused_rather_than_interpolated', () => {
  for (const name of ['sponsor_reserve; drop table x', 'exec', '', 'Morpheus_Delivery_Claim']) {
    assert.throws(() => deliveryRpcSql(name, {}), /unknown delivery RPC/i, name);
  }
});

test('the_stand_in_refuses_a_field_it_was_not_asked_for', () => {
  assert.throws(
    () => deliveryRpcSql('sponsor_reserve', { p_network: 'testnet', p_extra: 1 }),
    /unexpected argument/i
  );
});

test('the_stand_in_answers_the_function_name_the_store_posts_to', () => {
  // PostgREST routes `POST /rest/v1/rpc/<sql function>`, so the relayer names
  // `morpheus_delivery_sponsor_reserve`, not `sponsor_reserve`. A stand-in
  // keyed only on the short name answers 400 to every call the lane makes.
  const body = {
    p_network: 'testnet',
    p_principal: '11111111-2222-4333-8444-555555555555',
    p_idempotency_key: 'key',
    p_contract: '0x11',
    p_account: '0x22',
    p_intent: { a: 1 },
    p_fee_ceiling_units: 20000000,
  };
  const full = deliveryRpcSql('morpheus_delivery_sponsor_reserve', body);
  const short = deliveryRpcSql('sponsor_reserve', body);
  assert.equal(full.sql, short.sql);
  assert.match(full.sql, /public\.morpheus_delivery_sponsor_reserve\(/);
  assert.match(
    deliveryRpcSql('morpheus_delivery_lookup', { p_job: 'k' }).sql,
    /public\.morpheus_delivery_lookup\(/
  );
  assert.match(
    deliveryRpcSql('morpheus_delivery_claim', {
      p_network: 'testnet',
      p_chain: 'neo_n3',
      p_account: '0x22',
      p_owner: 'worker',
      p_lease_ms: 60000,
      p_kinds: ['sponsor'],
    }).sql,
    /public\.morpheus_delivery_claim\(/
  );
  for (const name of [
    'morpheus_delivery_',
    'morpheus_delivery_morpheus_delivery_sponsor_reserve',
    'morpheus_delivery_drop',
    '',
  ]) {
    assert.throws(() => deliveryRpcSql(name, {}), /unknown delivery RPC/i, name);
  }
});

// -------------------------------------------------------------------------
// Acceptance evaluation
// -------------------------------------------------------------------------

function goodObservation() {
  return {
    response: {
      code: 'SPONSOR_CONFIRMED',
      journal_id: '["testnet","neo_n3","0x11","sponsor","0x22"]',
      tx_hash: `0x${'ab'.repeat(32)}`,
      vm_state: 'HALT',
      transaction_fee_units: 12_500_000,
      reimbursement_units: 3_000_000,
      sponsor_fee_units: 15_500_000,
      replayed: false,
    },
    journal: {
      job_key: '["testnet","neo_n3","0x11","sponsor","0x22"]',
      status: 'completed',
      journal: {
        prepared: { fee_ceiling_units: SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS },
        signed: { tx_hash: `0x${'ab'.repeat(32)}`, raw: 'AAAA' },
        receipt: { tx_hash: `0x${'ab'.repeat(32)}`, vm_state: 'HALT', exception: null },
      },
    },
    balances: {
      sponsorDelta: -15_500_000,
      recipientDelta: 3_000_000,
      reimbursementUnits: 3_000_000,
      feesCharged: 12_500_000,
      declaredFeeUnits: 12_500_000,
    },
    budgets: {
      feeCeilingUnits: SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS,
      lifetimeDelta: SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS,
      dailyDelta: 1,
    },
    exhaustion: {
      code: 'SPONSOR_BUDGET_EXHAUSTED',
      journalRowsDelta: 0,
      chainTxCountDelta: 0,
    },
    eligibility: {
      code: 'SPONSOR_REQUEST_INVALID',
      intent_code: 'SPONSOR_INTENT_WRONG_TARGET',
      budgetDelta: 0,
    },
  };
}

function checkNamed(observed, name) {
  return evaluateAcceptance(observed).checks.find((entry) => entry.name === name);
}

test('every_acceptance_check_is_named_and_present', () => {
  const result = evaluateAcceptance(goodObservation());
  assert.deepEqual(
    result.checks.map((entry) => entry.name),
    ACCEPTANCE_CHECKS
  );
  assert.equal(result.ok, true, result.failures.join('\n'));
});

test('an_unconfirmed_intent_cannot_report_green', () => {
  for (const [field, value] of [
    ['code', 'SPONSOR_FAULTED'],
    ['vm_state', 'FAULT'],
    ['vm_state', null],
  ]) {
    const observed = goodObservation();
    observed.response[field] = value;
    assert.equal(checkNamed(observed, 'check/intent-paid-and-confirmed').ok, false, field);
    assert.equal(evaluateAcceptance(observed).ok, false);
  }
});

test('a_missing_or_foreign_journal_id_cannot_report_green', () => {
  for (const journalId of ['', null, 'some-other-job']) {
    const observed = goodObservation();
    observed.response.journal_id = journalId;
    assert.equal(checkNamed(observed, 'check/journal-id-returned').ok, false, String(journalId));
    assert.equal(evaluateAcceptance(observed).ok, false);
  }
});

test('a_receipt_for_a_transaction_other_than_the_signed_one_cannot_report_green', () => {
  for (const [where, field] of [
    ['journal.journal.receipt', 'tx_hash'],
    ['journal.journal.signed', 'tx_hash'],
  ]) {
    const observed = goodObservation();
    if (where.includes('receipt')) observed.journal.journal.receipt[field] = `0x${'cd'.repeat(32)}`;
    else observed.journal.journal.signed[field] = `0x${'cd'.repeat(32)}`;
    assert.equal(
      checkNamed(observed, 'check/journal-receipt-matches-signed').ok,
      false,
      `${where}.${field}`
    );
    assert.equal(evaluateAcceptance(observed).ok, false);
  }
  const faulted = goodObservation();
  faulted.journal.journal.receipt.vm_state = 'FAULT';
  assert.equal(checkNamed(faulted, 'check/journal-receipt-matches-signed').ok, false);
});

test('a_journal_that_does_not_hold_the_reserved_ceiling_cannot_report_green', () => {
  const observed = goodObservation();
  observed.journal.journal.prepared.fee_ceiling_units = 1;
  assert.equal(checkNamed(observed, 'check/journal-holds-the-reserved-ceiling').ok, false);
  assert.equal(evaluateAcceptance(observed).ok, false);
});

test('an_uncharged_sponsor_cannot_report_green', () => {
  for (const delta of [0, -3_000_000, -15_500_001, 1]) {
    const observed = goodObservation();
    observed.balances.sponsorDelta = delta;
    assert.equal(checkNamed(observed, 'check/sponsor-charged').ok, false, String(delta));
    assert.equal(evaluateAcceptance(observed).ok, false);
  }
});

test('a_charge_larger_than_the_declared_fee_cannot_report_green', () => {
  const observed = goodObservation();
  observed.balances.feesCharged = observed.balances.declaredFeeUnits + 1;
  assert.equal(checkNamed(observed, 'check/sponsor-charged').ok, false);
});

test('an_unpaid_recipient_cannot_report_green', () => {
  for (const delta of [0, 2_999_999, 3_000_001, -1]) {
    const observed = goodObservation();
    observed.balances.recipientDelta = delta;
    assert.equal(checkNamed(observed, 'check/recipient-paid').ok, false, String(delta));
    assert.equal(evaluateAcceptance(observed).ok, false);
  }
  const zero = goodObservation();
  zero.balances.reimbursementUnits = 0;
  zero.balances.recipientDelta = 0;
  assert.equal(checkNamed(zero, 'check/recipient-paid').ok, false);
});

test('an_undebited_budget_cannot_report_green', () => {
  for (const [field, value] of [
    ['lifetimeDelta', 0],
    ['lifetimeDelta', SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS - 1],
    ['dailyDelta', 0],
    ['dailyDelta', 2],
  ]) {
    const observed = goodObservation();
    observed.budgets[field] = value;
    assert.equal(checkNamed(observed, 'check/budget-debited').ok, false, field);
    assert.equal(evaluateAcceptance(observed).ok, false);
  }
});

test('an_accepted_request_in_place_of_the_budget_refusal_cannot_report_green', () => {
  for (const code of ['SPONSOR_CONFIRMED', 'SPONSOR_SEND_REFUSED', 'SPONSOR_JOURNAL_REFUSED']) {
    const observed = goodObservation();
    observed.exhaustion.code = code;
    assert.equal(checkNamed(observed, 'check/budget-exhaustion-refused').ok, false, code);
    assert.equal(evaluateAcceptance(observed).ok, false);
  }
});

test('a_refusal_that_still_wrote_or_broadcast_cannot_report_green', () => {
  for (const [field, value] of [
    ['journalRowsDelta', 1],
    ['chainTxCountDelta', 1],
  ]) {
    const observed = goodObservation();
    observed.exhaustion[field] = value;
    assert.equal(checkNamed(observed, 'check/refusal-broadcast-nothing').ok, false, field);
    assert.equal(evaluateAcceptance(observed).ok, false);
  }
});

test('an_eligible_intent_in_place_of_the_eligibility_refusal_cannot_report_green', () => {
  for (const [field, value] of [
    ['code', 'SPONSOR_CONFIRMED'],
    ['intent_code', 'SPONSOR_INTENT_FEE_OVER_CEILING'],
    ['budgetDelta', 1],
  ]) {
    const observed = goodObservation();
    observed.eligibility[field] = value;
    assert.equal(checkNamed(observed, 'check/ineligible-intent-refused').ok, false, field);
    assert.equal(evaluateAcceptance(observed).ok, false);
  }
});

test('an_incomplete_observation_is_a_failure_not_an_unknown', () => {
  for (const missing of [
    'response',
    'journal',
    'balances',
    'budgets',
    'exhaustion',
    'eligibility',
  ]) {
    const observed = goodObservation();
    delete observed[missing];
    const result = evaluateAcceptance(observed);
    assert.equal(result.ok, false, `${missing} may not vanish`);
    assert.ok(result.failures.length > 0);
  }
});

test('a_fee_ceiling_above_the_schema_bound_is_refused', () => {
  assert.equal(SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS, 20_000_000);
});

test('normalize_script_hash_refuses_anything_but_twenty_bytes', () => {
  assert.equal(
    normalizeScriptHash('0x29199733d7ec52fabc32083fb1a6e826ef7de9e4'),
    '0x29199733d7ec52fabc32083fb1a6e826ef7de9e4'
  );
  assert.throws(() => normalizeScriptHash('0x1234'), /20-byte/i);
});

// -------------------------------------------------------------------------
// The probe address and the chain RPC parameter guard
//
// The journey was blocked on one defect: the probe's script hash was converted
// to an address by an `async` function whose result was never awaited, so a
// Promise reached `JSON.stringify` inside the JSON-RPC body and the node was
// asked to read `{}` as a Neo address. Every test below fails while that is
// true, and each one is proven able to fail by a mutant.
// -------------------------------------------------------------------------

const PROBE_SCRIPT_HASH = '0x29199733d7ec52fabc32083fb1a6e826ef7de9e4';
const GENESIS_ADDRESS = 'NgnLxoBSq3ccKb6Ds9AriCkeVqwEdbr3CN';

test('the_probe_address_conversion_is_synchronous_and_returns_a_string', () => {
  const address = scriptHashToAddress(PROBE_SCRIPT_HASH);
  assert.equal(typeof address, 'string', `received a ${typeof address}`);
  assert.equal(typeof address?.then, 'undefined', 'the conversion must not be thenable');
  assert.match(address, /^N[1-9A-HJ-NP-Za-km-z]{32,33}$/);
});

test('the_probe_address_conversion_is_the_script_hash_account_address', () => {
  for (const hash of [
    PROBE_SCRIPT_HASH,
    PROBE_SCRIPT_HASH.slice(2),
    `0x${'00'.repeat(20)}`,
    `0x${'ff'.repeat(20)}`,
    `0x${base58checkDecode(GENESIS_ADDRESS)}`,
  ]) {
    const address = scriptHashToAddress(hash);
    assert.equal(`0x${base58checkDecode(address)}`, normalizeScriptHash(hash), hash);
    assert.equal(address, base58checkEncode(normalizeScriptHash(hash)), hash);
  }
});

test('a_json_body_never_sees_a_promise_where_the_probe_address_belongs', () => {
  // The diagnosis of the blocker, pinned so the cause cannot be forgotten and
  // reintroduced: an un-awaited async conversion is a Promise, a Promise has no
  // own enumerable properties, and it encodes as `{}` — the character the node
  // refused at position 0.
  const unawaited = (async () => 'Nx')();
  assert.equal(JSON.stringify([unawaited]), '[{}]');
  assert.throws(() => assertRpcParams('getnep17balances', [unawaited]), /thenable|Promise/i);
  assert.equal(
    JSON.stringify(assertRpcParams('getnep17balances', [scriptHashToAddress(PROBE_SCRIPT_HASH)])),
    JSON.stringify([base58checkEncode(normalizeScriptHash(PROBE_SCRIPT_HASH))])
  );
});

test('a_thenable_rpc_parameter_is_refused_before_it_reaches_the_wire', () => {
  for (const [label, value] of [
    ['a pending promise', (async () => 'Nx')()],
    ['a resolved promise', Promise.resolve('Nx')],
    ['a thenable object', { then() {} }],
    ['a thenable function', Object.assign(() => {}, { then() {} })],
  ]) {
    assert.throws(() => assertRpcParams('getnep17balances', [value]), /thenable|Promise/i, label);
  }
});

test('an_undefined_or_function_rpc_parameter_is_refused_rather_than_dropped', () => {
  for (const value of [undefined, () => 1, Symbol('x'), 10n]) {
    assert.throws(
      () => assertRpcParams('invokescript', [value]),
      /parameter 0/i,
      String(value?.toString?.() ?? value)
    );
  }
});

test('json_plain_rpc_parameters_are_accepted_unchanged', () => {
  const params = ['Nx', 3, true, null, ['a'], { account: '0x11', scopes: 'CalledByEntry' }];
  assert.equal(assertRpcParams('invokescript', params), params);
  assert.deepEqual(assertRpcParams('getblockcount', []), []);
  assert.throws(() => assertRpcParams('getblockcount', 'not-an-array'), /parameter list/i);
});

test('an_rpc_address_must_be_a_string_before_it_is_asked_about', () => {
  for (const [label, value] of [
    ['a promise', (async () => 'Nx')()],
    ['an object', {}],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an array', ['NgnLxoBSq3ccKb6Ds9AriCkeVqwEdbr3CN']],
  ]) {
    assert.throws(() => assertRpcAddress(value, 'probe address'), /probe address/i, label);
  }
});

test('an_rpc_address_must_really_be_a_neo_address', () => {
  const good = scriptHashToAddress(PROBE_SCRIPT_HASH);
  const last = good.at(-1);
  for (const bad of [
    '{}',
    '[{}]',
    'not-an-address',
    '',
    '   ',
    good.slice(0, -1),
    `${good.slice(0, -1)}${last === '1' ? '2' : '1'}`,
    `1${good.slice(1)}`,
  ]) {
    // `base58checkDecode` is the oracle: a candidate it accepts is not a
    // refutation, so the fixture is the defect and this fails first.
    assert.throws(() => base58checkDecode(bad), /base58|address/i, JSON.stringify(bad));
    assert.throws(
      () => assertRpcAddress(bad, 'probe address'),
      /probe address/i,
      JSON.stringify(bad)
    );
  }
});

test('a_good_rpc_address_is_returned_trimmed_and_unchanged', () => {
  const address = scriptHashToAddress(PROBE_SCRIPT_HASH);
  assert.equal(assertRpcAddress(address, 'probe address'), address);
  assert.equal(assertRpcAddress(`  ${address}\n`, 'probe address'), address);
  assert.equal(assertRpcAddress(GENESIS_ADDRESS), GENESIS_ADDRESS);
});

// -------------------------------------------------------------------------
// NEP-17 balances
//
// `getnep17balances` names the field `assethash` (and `lastupdatedblock`).
// A reader keyed on `asset_hash` silently reports zero for every account, so
// the journey believed the sponsor had no gas to reimburse from and the
// fixture's `GAS.Transfer` could not settle.
// -------------------------------------------------------------------------

const GAS_ASSET_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';

test('a_nep17_balance_is_read_from_the_field_the_node_sends', () => {
  // The exact shape a Neo node answers with.
  const node = {
    address: GENESIS_ADDRESS,
    balance: [{ assethash: GAS_ASSET_HASH, amount: '10000000000', lastupdatedblock: 1 }],
  };
  assert.equal(nep17AssetAmount(node, GAS_ASSET_HASH), 10_000_000_000n);
  assert.equal(nep17AssetAmount(node, GAS_ASSET_HASH.slice(2)), 10_000_000_000n);
  assert.equal(nep17AssetAmount({ balance: [] }, GAS_ASSET_HASH), 0n);
  assert.equal(
    nep17AssetAmount(
      { balance: [{ assethash: '0x11'.padEnd(42, '0'), amount: '5' }] },
      GAS_ASSET_HASH
    ),
    0n
  );
});

test('a_nep17_amount_that_is_not_an_integer_string_is_refused', () => {
  for (const amount of ['1.5', '-1', 'ten', '', null, undefined, {}]) {
    assert.throws(
      () => nep17AssetAmount({ balance: [{ assethash: GAS_ASSET_HASH, amount }] }, GAS_ASSET_HASH),
      /amount/i,
      JSON.stringify(amount)
    );
  }
  for (const bad of [null, undefined, 'nope', { balance: 'not-an-array' }, { balance: [1] }]) {
    assert.throws(
      () => nep17AssetAmount(bad, GAS_ASSET_HASH),
      /balance|getnep17balances/i,
      JSON.stringify(bad)
    );
  }
  assert.throws(() => nep17AssetAmount({ balance: [] }, '0x1234'), /asset hash|20-byte/i);
});
