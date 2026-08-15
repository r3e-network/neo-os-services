import * as Sentry from '@sentry/nextjs';
import {
  sentryEnvironment,
  sentryProfilesSampleRate,
  sentryTracesSampleRate,
  serverSentryDsn,
} from './sentry.shared';

if (serverSentryDsn) {
  Sentry.init({
    dsn: serverSentryDsn,
    environment: sentryEnvironment,
    tracesSampleRate: sentryTracesSampleRate,
    profilesSampleRate: sentryProfilesSampleRate,
    enabled: true,
    sendDefaultPii: false,
  });
}
