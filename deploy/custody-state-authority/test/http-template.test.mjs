import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { makeHandler } from '../src/http.mjs';
import { sha256Hex } from '../src/codec.mjs';

const templatePath = new URL('../template.yaml', import.meta.url);
const attestationPath = new URL('../src/attestation.mjs', import.meta.url);

function resourceSection(template, resourceName, nextResourceName) {
  const start = template.indexOf(`  ${resourceName}:`);
  const end = template.indexOf(`  ${nextResourceName}:`, start);
  assert.notEqual(start, -1, `missing resource ${resourceName}`);
  assert.notEqual(end, -1, `missing resource ${nextResourceName}`);
  return template.slice(start, end);
}

function leadingKeysForAction(section, action) {
  const start = section.indexOf(`Action: ${action}`);
  assert.notEqual(start, -1, `missing action ${action}`);
  const nextStatement = section.indexOf('\n              - Effect:', start + 1);
  const statement = section.slice(start, nextStatement === -1 ? section.length : nextStatement);
  return [...statement.matchAll(/- '([^']+#\*)'/g)].map((match) => match[1]);
}

function event(overrides = {}) {
  return {
    requestContext: { requestId: 'request-1', http: { method: 'POST' } },
    headers: { 'content-type': 'application/json' },
    body: '{}',
    pathParameters: {},
    ...overrides,
  };
}

test('HTTP wrapper rejects non-JSON and missing custody-session credentials', async () => {
  const bodyHandler = makeHandler({
    method: 'POST',
    body: true,
    async invoke({ input }) {
      return { statusCode: 200, body: input };
    },
  });
  const media = await bodyHandler(event({ headers: { 'content-type': 'text/plain' } }));
  assert.equal(media.statusCode, 415);
  assert.equal(JSON.parse(media.body).error.code, 'unsupported_media_type');

  const sessionHandler = makeHandler({
    method: 'POST',
    route: '/v1/vaults/{vaultId}/profiles/{profileId}/test',
    body: true,
    session: true,
    async invoke() {
      return { statusCode: 200, body: {} };
    },
  });
  const unauthorized = await sessionHandler(event());
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(JSON.parse(unauthorized.body).error.code, 'invalid_session');

  const query = await bodyHandler(event({ rawQueryString: 'unsafe=1' }));
  assert.equal(query.statusCode, 400);
  assert.equal(JSON.parse(query.body).error.code, 'query_not_allowed');
});

test('HTTP proof hashes original bytes including whitespace and decoded base64', async () => {
  const handler = makeHandler({
    method: 'POST', route: '/v1/vaults/{vaultId}/test', body: true, session: true,
    async invoke({ proof }) { return { statusCode: 200, body: { digest: proof.bodySha256 } }; },
  });
  const headers = {
    'content-type': 'application/json',
    'x-custody-session': 'T'.repeat(43),
    'x-custody-pop-timestamp': '1800000000000',
    'x-custody-pop-nonce': '11'.repeat(32),
    'x-custody-pop-signature': 'placeholder-not-verified-by-wrapper',
  };
  for (const raw of ['{"a":1}', '{ "a": 1 }']) {
    for (const encoded of [false, true]) {
      const result = await handler(event({ headers, pathParameters: { vaultId: 'vault' },
        body: encoded ? Buffer.from(raw).toString('base64') : raw, isBase64Encoded: encoded }));
      assert.equal(result.statusCode, 200);
      assert.equal(JSON.parse(result.body).digest, sha256Hex(Buffer.from(raw)));
    }
  }
});

test('SAM template pins the independent state, storage, signing and parent boundaries', async () => {
  const template = await readFile(templatePath, 'utf8');
  assert.match(template, /Transform: AWS::Serverless-2016-10-31/);
  assert.match(template, /DefaultAuthorizer: AWS_IAM/);
  assert.match(template, /DeletionProtectionEnabled: true/);
  assert.match(template, /PointInTimeRecoveryEnabled: true/);
  assert.match(template, /ObjectLockEnabled: true/);
  assert.match(template, /Mode: COMPLIANCE/);
  assert.match(template, /VersioningConfiguration:\n\s+Status: Enabled/);
  assert.match(template, /BlockPublicAcls: true/);
  assert.match(template, /KeySpec: ECC_NIST_P256/);
  assert.match(template, /KeyUsage: SIGN_VERIFY/);
  assert.match(template, /Action: kms:Sign/);
  assert.match(template, /s3:PutObjectRetention/);
  assert.match(template, /s3:GetObjectRetention/);
  assert.match(template, /DenyDirectCustodyStateMutation/);
  assert.match(template, /Action: 'kms:\*'/);
  assert.match(template, /Action: execute-api:Invoke/);
  const parentRole = template.slice(
    template.indexOf('  NitroParentInvokeRole:'),
    template.indexOf('  NitroParentInstanceProfile:')
  );
  const parentAllowSection = parentRole.slice(0, parentRole.indexOf('        - PolicyName: Deny'));
  assert.doesNotMatch(parentAllowSection, /dynamodb:|s3:|kms:/);
  assert.match(parentRole, /Effect: Deny[\s\S]*dynamodb:TransactWriteItems/);
  assert.match(parentRole, /Effect: Deny[\s\S]*s3:PutObject/);
  assert.match(template, /RECEIPT_KEY_ID: !Ref ReceiptKeyId/);
  assert.match(template, /VerifyHeadAndPresignExactSnapshotVersion/);
  assert.equal(
    (template.match(/AllowedPattern: '\^\(\?!0\{96\}\$\)\[0-9a-f\]\{96\}\$'/g) || []).length,
    3
  );
  for (const parameter of [
    'ExpectedVaultId',
    'ExpectedProfileId',
    'ExpectedNetworkId',
    'ExpectedRootCommitment',
  ]) {
    assert.match(template, new RegExp(`\\n  ${parameter}:`));
  }
  for (const variable of [
    'EXPECTED_VAULT_ID',
    'EXPECTED_PROFILE_ID',
    'EXPECTED_NETWORK_ID',
    'EXPECTED_ROOT_COMMITMENT',
  ]) {
    assert.match(template, new RegExp(`${variable}: !Ref`));
  }
  assert.match(template, /Resource: !Sub '\$\{SnapshotBucket\.Arn\}\/snapshots\/v2\/\*'/);
  const uploadRole = resourceSection(template, 'UploadTicketFunctionRole', 'UploadTicketFunction');
  const statusRole = resourceSection(template, 'UploadStatusFunctionRole', 'UploadStatusFunction');
  assert.match(statusRole, /kms:Decrypt/);
  assert.match(statusRole, /kms:GenerateDataKey/);
  assert.match(statusRole, /kms:ViaService:/);
  assert.match(statusRole, /s3:ListBucketVersions/);
  assert.match(template, /StageName:[\s\S]*?AllowedValues:\n\s+- '\$default'/);
  assert.deepEqual(leadingKeysForAction(uploadRole, 'dynamodb:GetItem'), [
    'SESSION#*',
    'COMMIT#*',
    'STATE#*',
  ]);
  assert.deepEqual(leadingKeysForAction(uploadRole, 'dynamodb:TransactWriteItems'), [
    'STATE#*',
    'COMMIT#*',
  ]);
  const downloadRole = resourceSection(
    template,
    'DownloadTicketFunctionRole',
    'DownloadTicketFunction'
  );
  assert.deepEqual(leadingKeysForAction(downloadRole, 'dynamodb:GetItem'), [
    'SESSION#*',
    'STATE#*',
  ]);
  const renewRole = resourceSection(template, 'RenewFunctionRole', 'RenewFunction');
  assert.deepEqual(leadingKeysForAction(renewRole, 'dynamodb:GetItem'), ['SESSION#*', 'STATE#*']);
  assert.deepEqual(leadingKeysForAction(renewRole, 'dynamodb:UpdateItem'), ['STATE#*']);
  assert.equal((template.match(/Type: AWS::Serverless::Function/g) || []).length, 9);
  for (const route of [
    '/v1/challenges',
    '/v1/sessions',
    '/head',
    '/upload-tickets',
    '/upload-status',
    '/download-tickets',
    '/commits',
    '/takeover',
    '/renew',
  ]) {
    assert.ok(template.includes(route), `missing route ${route}`);
  }
});

test('production attestation module contains no configurable allow path', async () => {
  const source = await readFile(attestationPath, 'utf8');
  assert.match(source, /verified: false/);
  assert.match(source, /verified: true/);
  assert.match(source, /AWS_NITRO_ROOT_SHA256/);
  assert.match(source, /SignedAttestation\.fromDocument/);
  assert.match(source, /verifyRootOfTrust/);
  assert.match(source, /verifySignature/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /ALLOW|BYPASS|SKIP/);
});
