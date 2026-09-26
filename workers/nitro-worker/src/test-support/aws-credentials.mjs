// Test-only helper; nothing in the worker imports it.
//
// platform/nitro-signer.js builds a real Secrets Manager client whenever no
// secrets provider is installed through __setSecretsProviderForTests, and that
// client resolves credentials through the AWS SDK's default chain: credential
// environment variables, the shared credentials and config files (and the
// profiles, SSO and process credentials they name), container and web-identity
// credentials, and the EC2 instance metadata service. On a machine that holds
// AWS credentials, a test that reaches that client, or a regressed build that
// stops using the test seam, would send a real GetSecretValue request.
// isolateAwsCredentials() leaves that chain nothing to find.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REMOVED_ENV_KEYS = Object.freeze([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
]);

export const AWS_CREDENTIAL_ENV_KEYS = Object.freeze([
  ...REMOVED_ENV_KEYS,
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_EC2_METADATA_DISABLED',
]);

/**
 * Removes every credential source the AWS SDK's default chain reads from the
 * process environment, points the shared credentials and config files at a path
 * that cannot exist, and disables the instance metadata service. Returns a
 * function that restores the previous values; pass it to `t.after` or
 * `test.after`.
 */
export function isolateAwsCredentials() {
  const saved = new Map(AWS_CREDENTIAL_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of REMOVED_ENV_KEYS) delete process.env[key];
  // A file inside a directory that is never created.
  const absent = join(tmpdir(), `neoos-no-aws-${process.pid}-${randomUUID()}`, 'absent');
  process.env.AWS_SHARED_CREDENTIALS_FILE = absent;
  process.env.AWS_CONFIG_FILE = absent;
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  return function restoreAwsCredentials() {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
