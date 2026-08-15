import * as Sentry from '@sentry/nextjs';
import { sentryEnvironment, sentryTracesSampleRate, serverSentryDsn } from './sentry.shared';

if (serverSentryDsn) {
  Sentry.init({
    dsn: serverSentryDsn,
    environment: sentryEnvironment,
    tracesSampleRate: sentryTracesSampleRate,
    enabled: true,
    sendDefaultPii: false,
  });
}
