import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OracleResponseViewer source contract', () => {
  it('renders package readiness detail as visible body copy, not only a tooltip', () => {
    const source = readFileSync(
      resolve(__dirname, '../components/dashboard/OracleResponseViewer.tsx'),
      'utf8'
    );

    expect(source).toContain('{readinessDetail && (');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('{readinessDetail}');
    expect(source).toContain('title={readinessDetail || undefined}');
    expect(source).toContain("overflowWrap: 'anywhere'");
    expect(source).toContain("wordBreak: 'break-word'");
  });
});
