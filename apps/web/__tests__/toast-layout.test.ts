import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Toast layout source contract', () => {
  it('keeps the fixed toast stack inside narrow mobile viewports', () => {
    const source = readFileSync(resolve(__dirname, '../components/ui/Toast.tsx'), 'utf8');

    expect(source).toContain("width: 'min(420px, calc(100vw - 32px))'");
    expect(source).toContain("maxWidth: 'calc(100vw - 32px)'");
    expect(source).toContain("right: 'clamp(16px, 4vw, 24px)'");
    expect(source).toContain("overflowWrap: 'anywhere'");
  });
});
