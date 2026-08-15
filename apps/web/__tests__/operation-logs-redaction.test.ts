import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for operation-log secret redaction (A1/E1).
 *
 * `signing_key` is consumed by /sign/payload + /relay/transaction and was
 * previously written cleartext to Supabase + BetterStack. It must be redacted
 * (along with the mnemonic/seed/passphrase/credential family), while public
 * key material (public_key / oracle_public_key / key_role) must NOT be
 * over-redacted.
 */

const insertedRows: Array<Record<string, any>> = [];
const insert = vi.fn(async (row: Record<string, any>) => {
  insertedRows.push(row);
  return { error: null };
});
const betterstackPayloads: Array<Record<string, any>> = [];
const getServerSupabaseClient = vi.fn(() => ({
  from: vi.fn(() => ({ insert })),
}));
const resolveProjectIdBySlug = vi.fn(async () => null);
const resolveSupabaseNetwork = vi.fn(() => 'testnet');
const emitBetterStackOperationLog = vi.fn((payload: Record<string, any>) => {
  betterstackPayloads.push(payload);
});

vi.mock('@/lib/server-supabase', () => ({
  getServerSupabaseClient,
  resolveProjectIdBySlug,
  resolveSupabaseNetwork,
}));
vi.mock('@/lib/betterstack-log-sink', () => ({ emitBetterStackOperationLog }));

async function importModule() {
  const mod = await import('../lib/operation-logs');
  return { ...mod, flush: mod.flushPendingOperationLogs };
}

describe('operation log secret redaction', () => {
  beforeEach(() => {
    vi.resetModules();
    insertedRows.length = 0;
    betterstackPayloads.length = 0;
    insert.mockClear();
    emitBetterStackOperationLog.mockClear();
  });

  it('redacts signing_key and signingKey in both Supabase and BetterStack payloads', async () => {
    const { recordOperationLog, flush } = await importModule();
    await recordOperationLog({
      route: '/api/relay/transaction',
      method: 'POST',
      category: 'relay',
      requestPayload: {
        signing_key: 'KxSECRETwifvalue1111111111111111111111111111111111111',
        signingKey: 'KySECRETwifvalue2222222222222222222222222222222222222',
        target_chain: 'neo_n3',
      },
      httpStatus: 200,
    });
    await flush();

    expect(insertedRows.length).toBe(1);
    const row = insertedRows[0];
    expect(row.request_payload.signing_key).toBe('[REDACTED]');
    expect(row.request_payload.signingKey).toBe('[REDACTED]');

    expect(betterstackPayloads.length).toBe(1);
    expect(betterstackPayloads[0].request_payload.signing_key).toBe('[REDACTED]');
    expect(betterstackPayloads[0].request_payload.signingKey).toBe('[REDACTED]');
  });

  it('redacts the mnemonic/seed/passphrase/credential family', async () => {
    const { recordOperationLog, flush } = await importModule();
    await recordOperationLog({
      route: '/api/sign/payload',
      method: 'POST',
      category: 'signing',
      requestPayload: {
        mnemonic: 'twelve words that should never be logged in clear text here',
        seed: 'deadbeefseed',
        passphrase: 'hunter2',
        credential: 'supersecret',
      },
      httpStatus: 200,
    });
    await flush();

    const row = insertedRows[0];
    expect(row.request_payload.mnemonic).toBe('[REDACTED]');
    expect(row.request_payload.seed).toBe('[REDACTED]');
    expect(row.request_payload.passphrase).toBe('[REDACTED]');
    expect(row.request_payload.credential).toBe('[REDACTED]');
  });

  it('redacts raw-string payloads by value shape (raw_body/raw_payload/raw_string)', async () => {
    const { recordOperationLog, flush } = await importModule();
    await recordOperationLog({
      route: '/api/relay/transaction',
      method: 'POST',
      category: 'relay',
      requestPayload: {
        raw_body: 'KxSECRETwifsmuggledInAnOpaqueBlob1111111111111111111111111',
        raw_payload: '{"wif":"KySECRETnestedInRawJson2222222222222222222222222"}',
        rawString: 'another opaque secret blob',
        request_id: 'req-123',
      },
      httpStatus: 200,
    });
    await flush();

    const row = insertedRows[0];
    expect(row.request_payload.raw_body).toMatch(/^\[REDACTED-RAW sha256:[0-9a-f]{16}\]$/);
    expect(row.request_payload.raw_payload).toMatch(/^\[REDACTED-RAW sha256:[0-9a-f]{16}\]$/);
    expect(row.request_payload.rawString).toMatch(/^\[REDACTED-RAW sha256:[0-9a-f]{16}\]$/);
    // Non-secret structured fields are preserved.
    expect(row.request_payload.request_id).toBe('req-123');
    // The same opaque value hashes identically (stable fingerprint).
    expect(betterstackPayloads[0].request_payload.raw_body).toBe(row.request_payload.raw_body);
  });

  it('scrubs credentials embedded in URL userinfo for any string value', async () => {
    const { recordOperationLog, flush } = await importModule();
    await recordOperationLog({
      route: '/api/feeds/tick',
      method: 'POST',
      category: 'feed',
      requestPayload: {
        upstream: 'https://user:s3cr3tpass@provider.example.com/v1/prices',
        note: 'no credentials here',
      },
      httpStatus: 200,
    });
    await flush();

    const row = insertedRows[0];
    expect(row.request_payload.upstream).toBe('https://[REDACTED]@provider.example.com/v1/prices');
    expect(row.request_payload.note).toBe('no credentials here');
  });

  it('redacts secrets in a raw JSON-string requestPayload (NeoDID/oracle proxy routes)', async () => {
    const { recordOperationLog, flush } = await importModule();
    // The NeoDID/oracle proxy routes log `requestPayload: await request.text()`,
    // i.e. the raw body as a JSON string. A root JSON string has no keys, so it
    // previously bypassed the key-name redactor and persisted id_token/wif/
    // private_key in cleartext to Supabase + BetterStack.
    await recordOperationLog({
      route: '/api/neodid/recovery-ticket',
      method: 'POST',
      category: 'system',
      requestPayload: JSON.stringify({
        provider: 'web3auth',
        id_token: 'eyJSECRET.web3auth.idtoken.replayable.value',
        private_key: 'KxSECRETprivkey1111111111111111111111111111111111111',
        wif: 'KySECRETwif2222222222222222222222222222222222222222',
        neodid_secret_salt: 'attacker-chosen-salt',
        account_id: 'aa-recovery-demo',
      }),
      httpStatus: 200,
    });
    await flush();

    const row = insertedRows[0];
    // Parsed + sanitized: secret-bearing fields redacted, structural fields kept.
    expect(row.request_payload.id_token).toBe('[REDACTED]');
    expect(row.request_payload.private_key).toBe('[REDACTED]');
    expect(row.request_payload.wif).toBe('[REDACTED]');
    expect(row.request_payload.neodid_secret_salt).toBe('[REDACTED]');
    expect(row.request_payload.account_id).toBe('aa-recovery-demo');
    // The raw token must not survive anywhere in the serialized row.
    expect(JSON.stringify(row.request_payload)).not.toContain('idtoken.replayable');
    expect(JSON.stringify(betterstackPayloads[0].request_payload)).not.toContain(
      'idtoken.replayable'
    );
  });

  it('hashes oversized raw JSON-string requestPayloads instead of parsing or previewing them', async () => {
    const { recordOperationLog, flush } = await importModule();
    const largeJsonBody = JSON.stringify({
      id_token: 'eyJSECRET.large.payload.token',
      note: 'x'.repeat(30000),
    });

    await recordOperationLog({
      route: '/api/neodid/recovery-ticket',
      method: 'POST',
      category: 'system',
      requestPayload: largeJsonBody,
      httpStatus: 200,
    });
    await flush();

    const row = insertedRows[0];
    expect(row.request_payload).toMatchObject({
      truncated: true,
      omitted: 'large JSON string payload',
      size: largeJsonBody.length,
    });
    expect(row.request_payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.request_payload.preview).toBeUndefined();
    expect(JSON.stringify(row.request_payload)).not.toContain('large.payload.token');
    expect(JSON.stringify(betterstackPayloads[0].request_payload)).not.toContain(
      'large.payload.token'
    );
  });

  it('does not over-redact public key material', async () => {
    const { recordOperationLog, flush } = await importModule();
    await recordOperationLog({
      route: '/api/sign/payload',
      method: 'POST',
      category: 'signing',
      requestPayload: {
        public_key: '03abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcab',
        oracle_public_key: '02ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        key_role: 'oracle',
      },
      httpStatus: 200,
    });
    await flush();

    const row = insertedRows[0];
    expect(row.request_payload.public_key).not.toBe('[REDACTED]');
    expect(row.request_payload.oracle_public_key).not.toBe('[REDACTED]');
    expect(row.request_payload.key_role).toBe('oracle');
  });

  it('redacts sensitive children before preserving encrypted envelopes', async () => {
    const { recordOperationLog, flush } = await importModule();
    await recordOperationLog({
      route: '/api/oracle/query',
      method: 'POST',
      category: 'oracle',
      requestPayload: {
        target_chain: 'neo_n3',
        encrypted_token: 'sealed-top-level-token',
        encrypted_inputs: {
          ciphertext: 'sealed-input',
          private_key: 'KxCLEARprivatekey',
          token: 'CLEAR-bearer-token',
        },
        encrypted_payload: {
          payload: 'sealed-nested-payload',
          signing_key: 'KyCLEARsigningkey',
        },
      },
      httpStatus: 200,
    });
    await flush();

    const operationRow = insertedRows[0];
    expect(operationRow.request_payload.encrypted_token).toBe('sealed-top-level-token');
    expect(operationRow.request_payload.encrypted_inputs).toEqual({
      ciphertext: 'sealed-input',
      private_key: '[REDACTED]',
      token: '[REDACTED]',
    });
    expect(operationRow.request_payload.encrypted_payload).toEqual({
      payload: 'sealed-nested-payload',
      signing_key: '[REDACTED]',
    });

    const encryptedRows = insertedRows[1] as unknown as Array<Record<string, unknown>>;
    expect(
      encryptedRows.map((row) => (row.metadata as Record<string, unknown>).field_path)
    ).toEqual(expect.arrayContaining(['encrypted_token', 'encrypted_inputs.ciphertext']));
    expect(JSON.stringify(encryptedRows)).not.toContain('KxCLEARprivatekey');
    expect(JSON.stringify(encryptedRows)).not.toContain('CLEAR-bearer-token');
    expect(JSON.stringify(encryptedRows)).not.toContain('KyCLEARsigningkey');
  });

  it('sanitizes and bounds upstream error strings in Supabase and BetterStack', async () => {
    const { recordOperationLog, flush } = await importModule();
    const rawError =
      'upstream failed Authorization: Bearer raw-access-token ' +
      'private_key="KxRAWprivatekey" ' +
      'https://operator:password@rpc.example.test/path ' +
      'x'.repeat(5000);

    await recordOperationLog({
      route: '/api/relay/transaction',
      method: 'POST',
      category: 'relay',
      responsePayload: rawError,
      httpStatus: 502,
      error: rawError,
    });
    await flush();

    const row = insertedRows[0];
    for (const persisted of [row.error, row.response_payload, betterstackPayloads[0].error]) {
      expect(persisted).not.toContain('raw-access-token');
      expect(persisted).not.toContain('KxRAWprivatekey');
      expect(persisted).not.toContain('operator:password');
      expect(persisted).toContain('[REDACTED]');
      expect(persisted).toContain('[TRUNCATED sha256:');
      expect(persisted.length).toBeLessThanOrEqual(2048);
    }
    expect(betterstackPayloads[0].response_payload).toBe(row.response_payload);
  });

  it('parses JSON upstream errors before redacting nested fields', async () => {
    const { recordOperationLog, flush } = await importModule();
    const jsonError = JSON.stringify({
      error: 'provider rejected Authorization: Bearer nested-access-token',
      details: {
        private_key: 'KxNESTEDprivatekey',
        endpoint: 'https://operator:nested-password@rpc.example.test/path',
      },
    });

    await recordOperationLog({
      route: '/api/sign/payload',
      method: 'POST',
      category: 'signing',
      responsePayload: jsonError,
      httpStatus: 502,
      error: jsonError,
    });
    await flush();

    const persisted = JSON.stringify({
      supabaseError: insertedRows[0].error,
      supabaseResponse: insertedRows[0].response_payload,
      betterstack: betterstackPayloads[0],
    });
    expect(persisted).not.toContain('nested-access-token');
    expect(persisted).not.toContain('KxNESTEDprivatekey');
    expect(persisted).not.toContain('operator:nested-password');
    expect(persisted).toContain('[REDACTED]');
  });
});
