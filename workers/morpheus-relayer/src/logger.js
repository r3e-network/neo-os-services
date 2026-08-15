import {
  createConsoleTransport,
  createLogger as createSharedLogger,
} from '@r3e-network/neo-os-services-shared/logger';
import { enqueueBetterStackLog } from './betterstack-log-sink.js';
import { trimString } from './lib/strings.js';
import { isSecretName, redactSecretValues } from './lib/secret-redaction.js';

// Scrub URLs (and any credentials embedded in authenticated RPC/DB URLs) from
// text that egresses to the external log sink. The on-chain error path is already
// scrubbed by fulfillment.js trimOnchainErrorMessage; the structured-log lane
// applies the same treatment to every string leaf so a credentialed RPC/Supabase
// URL inside an error message cannot leak in cleartext.
// SECURITY (S16): on top of URL scrubbing, apply the value-shape redaction
// patterns (Bearer/Basic credentials, Neo WIF, secret-key-context hex) so a
// non-URL secret value embedded in a message is also scrubbed.
function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text.replace(/https?:\/\/[^\s\]]+/gi, '[redacted-url]');
  return redactSecretValues(out);
}

export function createLogger(config = {}) {
  const format =
    trimString(
      config.logFormat ||
        process.env.MORPHEUS_RELAYER_LOG_FORMAT ||
        process.env.LOG_FORMAT ||
        'json'
    ) || 'json';
  const level =
    trimString(
      config.logLevel || process.env.MORPHEUS_RELAYER_LOG_LEVEL || process.env.LOG_LEVEL || 'info'
    ).toLowerCase() || 'info';
  const service = trimString(config.service || process.env.SERVICE_NAME || 'morpheus-relayer');

  // The shared logger only knows "json" and "pretty"; the relayer historically
  // uses "text" for the human-readable console format, so map that to pretty.
  const normalizedFormat = format === 'text' ? 'pretty' : format;

  return createSharedLogger({
    namespace: service,
    service,
    level,
    format: normalizedFormat,
    redactKeys: [isSecretName],
    redactor: redactSecrets,
    transports: [
      createConsoleTransport(normalizedFormat),
      (record) => {
        enqueueBetterStackLog({
          service,
          logger_format: format,
          ...record,
        });
      },
    ],
  });
}
