import { describe, expect, it } from 'vitest';
// @ts-expect-error next.config.mjs is intentionally authored as ESM JavaScript for Next.js.
import configWithSentry, { nextConfig } from '../next.config.mjs';

type SecurityHeader = { key: string; value: string };
type SecurityHeaderRule = { source: string; headers: SecurityHeader[] };
type NextConfigWithHeaders = {
  headers: () => Promise<SecurityHeaderRule[]>;
};

async function expectSecurityHeaders(
  config: NextConfigWithHeaders,
  options: { allowUnsafeEval?: boolean } = {}
) {
  const [rule] = await config.headers();
  const headers = new Map(rule.headers.map((header: SecurityHeader) => [header.key, header.value]));

  expect(rule.source).toBe('/(.*)');
  expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(headers.get('X-Frame-Options')).toBe('DENY');
  expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(headers.get('Strict-Transport-Security')).toContain('includeSubDomains');
  expect(headers.get('Permissions-Policy')).toContain('camera=()');

  const csp = headers.get('Content-Security-Policy') || '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  if (options.allowUnsafeEval) {
    expect(csp).toContain("'unsafe-eval'");
  } else {
    expect(csp).not.toContain("'unsafe-eval'");
  }
  expect(csp).not.toContain('script-src https:');
  expect(csp).not.toMatch(/script-src[^;]*\shttps:/);
  expect(csp).toContain('frame-ancestors');
  expect(csp).toContain("object-src 'none'");
}

describe('production security headers', () => {
  it('applies a complete baseline to the raw Next config', async () => {
    await expectSecurityHeaders(nextConfig);
  });

  it('keeps the same baseline after Sentry wraps the production export', async () => {
    await expectSecurityHeaders(configWithSentry);
  });

  it('allows unsafe-eval only in development so Next dev can hydrate interactive pages', async () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const previousNodeEnv = mutableEnv.NODE_ENV;
    mutableEnv.NODE_ENV = 'development';
    try {
      await expectSecurityHeaders(nextConfig, { allowUnsafeEval: true });
    } finally {
      mutableEnv.NODE_ENV = previousNodeEnv;
    }
  });
});
