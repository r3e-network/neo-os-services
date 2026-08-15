import {
  clientSentryDsn,
  sentryEnvironment,
  sentryProfilesSampleRate,
  sentryTracesSampleRate,
} from './sentry.shared';

if (clientSentryDsn) {
  void import('@sentry/nextjs')
    .then((Sentry) => {
      Sentry.init({
        dsn: clientSentryDsn,
        environment: sentryEnvironment,
        tracesSampleRate: sentryTracesSampleRate,
        profilesSampleRate: sentryProfilesSampleRate,
        enabled: true,
        sendDefaultPii: false,
      });
    })
    .catch((e) => {
      console.warn(
        '[sentry] client instrumentation failed to load:',
        e instanceof Error ? e.message : String(e)
      );
    });
}

export async function onRouterTransitionStart(...args: unknown[]) {
  if (!clientSentryDsn) return;
  const Sentry = await import('@sentry/nextjs');
  if (typeof Sentry.captureRouterTransitionStart === 'function') {
    return (Sentry.captureRouterTransitionStart as (...params: unknown[]) => unknown)(...args);
  }
}
