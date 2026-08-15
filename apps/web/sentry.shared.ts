function parseSampleRate(value: string | undefined, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

export const sentryEnvironment =
  process.env.SENTRY_ENVIRONMENT ||
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
  process.env.VERCEL_ENV ||
  process.env.NODE_ENV ||
  'development';

export const sentryTracesSampleRate = parseSampleRate(
  process.env.SENTRY_TRACES_SAMPLE_RATE || process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  0.1
);

export const sentryProfilesSampleRate = parseSampleRate(
  process.env.SENTRY_PROFILES_SAMPLE_RATE || process.env.NEXT_PUBLIC_SENTRY_PROFILES_SAMPLE_RATE,
  0
);

export const clientSentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN || '';
export const serverSentryDsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || '';
