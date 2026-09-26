// Test-only preload; nothing in the worker imports it.
//
// The worker's `test` script runs every test file with
// `node --import ./src/test-support/isolate-aws-credentials.mjs --test ...`,
// and node's test runner passes that flag to the child process of each file.
// Every worker test process therefore starts with the AWS SDK's default
// credential chain isolated (see aws-credentials.mjs), including a test file
// that installs no secrets provider and never calls isolateAwsCredentials()
// itself. The per-file calls stay as defence in depth for a file run on its
// own; aws-credentials-preload.test.mjs fails if this preload stops running.
import { isolateAwsCredentials } from './aws-credentials.mjs';

isolateAwsCredentials();
